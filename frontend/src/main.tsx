import { extensions, homeExtension } from "./extensions";
import { CSSProperties, PointerEvent as ReactPointerEvent, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, Me, NodeDetail, Theme } from "./api";
import { Tree } from "./Tree";
import { confirmDialog, DialogHost } from "./Dialog";
import { NodeView } from "./NodeView";
import { Dashboard, Recent } from "./Dashboard";
import { Admin, AdminNav } from "./Admin";
import { Faq } from "./Faq";
import { TaskBoard } from "./TaskBoard";
import { NetView } from "./Karte";
import { Search } from "./Search";
import {
  currentPath, DocTab, loadTabs, MAX_TABS, newTabId, nodeIdOf, pinnedFirst, saveTabs, TabBar, TabContext, TabState, wantsNewTab,
} from "./Tabs";
import { ProfileMenu } from "./ProfileMenu";
import { ForcedPassword } from "./Password";
import { NavTab, TabNav } from "./TabNav";
import "./styles.css";

// Top-level tabs: "overview", "team-<id>" (one per team, its area), "wiki" (areas outside every team), "tasks", "map",
// "faq" (Alle Anwender, the public areas) and "admin" (not in the bar).
type Tab = string;
const teamLabel = (name: string) => (/^team\b/i.test(name) ? name : `Team ${name}`);

/** The tab bar of a user: one tab per team (all teams for admins), the functions their teams have on, the FAQ. */
function tabsFor(me: Me): NavTab[] {
  const on = (f: string) => !!me.features?.includes(f); // the server decides: users without a team or rights only have the FAQ
  const nav = me.nav ?? { teams: [], other: false, public_areas: [] };
  return [
    { id: "overview", label: "Übersicht", path: "/" },
    ...(nav.private ? [{ id: "private", label: "Privat", path: `/n/${nav.private}` }] : []),
    ...(on("wiki") ? nav.teams.map((t) => ({ id: `team-${t.id}`, label: teamLabel(t.name), path: `/n/${t.area}`, team: true })) : []),
    ...(on("wiki") && nav.other ? [{ id: "wiki", label: "Wiki", path: "/wiki" }] : []),
    ...(on("tasks") ? [{ id: "tasks", label: "Aufgaben", path: "/aufgaben" }] : []),
    ...(on("network") ? [{ id: "map", label: "Netzwerk", path: "/netzwerk" }] : []),
    ...(on("faq") ? [{ id: "faq", label: "Alle Anwender", path: "/anwender" }] : []),
    ...extensions.filter((e) => e.show(me)).map((e) => ({ id: e.id, label: e.label, path: e.path })),
  ];
}


// The tab was called "Karte" before; old /karte links keep working.
if (location.pathname.startsWith("/karte")) {
  history.replaceState(null, "", location.pathname.replace(/^\/karte/, "/netzwerk") + location.search);
}



/** Which top-level tab a path belongs to; a page belongs to the tab of its area (nodeTab, looked up by the caller). */
function sectionOf(path: string, nodeTab: Tab | undefined): Tab {
  const p = path.split("?")[0];
  if (p.startsWith("/n/")) return nodeTab ?? "wiki";
  if (p.startsWith("/wiki")) return "wiki";
  if (p.startsWith("/anwender")) return "faq";
  if (p.startsWith("/verwaltung")) return "admin";
  if (p.startsWith("/aufgaben")) return "tasks";
  const ext = extensions.find((e) => p.startsWith(e.path));
  if (ext) return ext.id;
  return p.startsWith("/netzwerk") ? "map" : "overview";
}

// Paths a Ctrl/middle click may open as an in-app tab; everything else (downloads, admin, editors) stays native.
const TAB_PATH = /^\/(?:$|n\/|wiki|netzwerk|karte|verwaltung|aufgaben|anwender)/;

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            onLogin(await api<Me>("/api/auth/login", { method: "POST", body: { username, password } }));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Anmeldung fehlgeschlagen.");
          }
        }}
      >
        <h1><img src="/findus.svg" alt="" />Findus</h1>
        <label>
          Benutzername
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Passwort
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary">Anmelden</button>
      </form>
    </main>
  );
}

const SIDE_MIN = 200, SIDE_MAX = 560, SIDE_DEFAULT = 290;
const clampSide = (w: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)));

/** Drag edge between the sidebar and the content; the width is remembered per browser. */
function SideHandle({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const start = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const el = e.currentTarget, x0 = e.clientX, w0 = width;
    el.setPointerCapture(e.pointerId); el.classList.add("dragging"); document.body.classList.add("side-dragging");
    const move = (ev: PointerEvent) => onChange(clampSide(w0 + ev.clientX - x0));
    const end = () => { el.classList.remove("dragging"); document.body.classList.remove("side-dragging"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", end); el.removeEventListener("pointercancel", end); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  };
  return <button type="button" className="side-handle" role="separator" aria-orientation="vertical" aria-label="Breite der Seitenleiste ändern" aria-valuenow={width} aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX}
    onPointerDown={start} onDoubleClick={() => onChange(SIDE_DEFAULT)}
    onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onChange(clampSide(width + (e.key === "ArrowRight" ? 20 : -20))); } }} />;
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<TabState>({ tabs: [{ id: "start", path: currentPath() === "/" ? "/wiki" : currentPath() }], active: "start", split: null });
  // The overview is a page of its own, not a tab: opening it keeps every tab as it is.
  const [home, setHome] = useState(() => currentPath() === "/");
  const homeRef = useRef(home);
  homeRef.current = home;
  const [dirty, setDirtyMap] = useState<Record<string, boolean>>({});
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Bumped after any change so the tree reloads the affected branches.
  const [treeVersion, setTreeVersion] = useState(0);
  // index.html applies the stored theme before the first paint; the account setting wins once /me is loaded.
  const [sideW, setSideW] = useState(() => { try { const v = Number(localStorage.getItem("findus-side-width")); return v ? clampSide(v) : SIDE_DEFAULT; } catch { return SIDE_DEFAULT; } });
  const changeSide = (w: number) => { setSideW(w); try { w === SIDE_DEFAULT ? localStorage.removeItem("findus-side-width") : localStorage.setItem("findus-side-width", String(w)); } catch { /* private mode: not remembered */ } };
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) ?? "auto";
    } catch {
      return "auto";
    }
  });
  const applyMe = useCallback((m: Me) => {
    setMe(m);
    if (m.theme) setTheme(m.theme);
  }, []);
  const chooseTheme = (t: Theme) => {
    setTheme(t);
    if (me?.authenticated) api("/api/auth/settings", { method: "PUT", body: { theme: t } }).catch(() => {});
  };
  const anon = !!me && !me.authenticated;
  // Old shared FAQ links (/n/<id>): a published public page opens in the help portal, anything else asks for the login.
  const [linkChecked, setLinkChecked] = useState(false);
  useEffect(() => {
    if (!anon) return;
    const id = location.pathname.match(/^\/n\/([0-9a-f-]{36})/)?.[1];
    if (!id) return setLinkChecked(true);
    fetch(`/api/public/pages/${id}`, { credentials: "omit" })
      .then((r) => (r.ok ? location.replace(`/hilfe/?p=${id}`) : setLinkChecked(true)))
      .catch(() => setLinkChecked(true));
  }, [anon]);
  const user = me?.authenticated ? me.username ?? "" : null;
  const activeTab = state.tabs.find((t) => t.id === state.active) ?? state.tabs[0];
  const activePath = home ? "/" : activeTab.path;
  // The tab of the open page = the tab of its area; looked up once per page (the previous tab stays while it loads).
  const [areaTab, setAreaTab] = useState<Record<string, Tab>>({});
  const lastTab = useRef<Tab>("wiki");
  const openId = nodeIdOf(activePath);
  useEffect(() => {
    if (!me?.authenticated || !openId || areaTab[openId]) return;
    api<NodeDetail>(`/api/nodes/${openId}`).then((n) => {
      const root = n.breadcrumb[0]?.id ?? n.id;
      const team = me.nav?.teams.find((t) => t.area === root);
      // A folder another team shared with us opens in the receiving team's tab (via_team), not in the general wiki.
      setAreaTab((m) => ({ ...m, [openId]: team ? `team-${team.id}` : n.via_team ? `team-${n.via_team}` : n.via_user ? "private" : root === me.nav?.private ? "private" : me.nav?.public_areas.includes(root) ? "faq" : "wiki" }));
    }).catch(() => undefined);
  }, [me, openId, areaTab]);

  useEffect(() => {
    api<Me>("/api/auth/me").then(applyMe);
    // Back/forward: show that URL in its tab if one has it, otherwise in the active tab.
    const onPop = () => {
      const path = currentPath();
      setHome(path === "/");
      if (path === "/") return;
      setState((s) => {
        const hit = s.tabs.find((t) => t.path === path);
        return hit ? { ...s, active: hit.id } : { ...s, tabs: s.tabs.map((t) => (t.id === s.active ? { ...t, path } : t)) };
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  // Tabs are per user and survive a reload; the URL picks the active one.
  useEffect(() => { if (user) setState(loadTabs(user, currentPath())); }, [user]);
  useEffect(() => { if (user) saveTabs(user, state); }, [user, state]);
  // Tabs of a function the user's teams do not have (any more) are dropped, so nothing of it stays visible.
  useEffect(() => {
    if (!me?.features) return;
    const ok = (p: string) => !(p.startsWith("/aufgaben") && !me.features!.includes("tasks")) && !(/^\/(netzwerk|karte)/.test(p) && !me.features!.includes("network"));
    setState((s) => {
      if (s.tabs.every((t) => ok(t.path))) return s;
      const kept = s.tabs.filter((t) => ok(t.path));
      const tabs = kept.length ? kept : [{ id: newTabId(), path: "/wiki" }];
      return { ...s, tabs, active: tabs.some((t) => t.id === s.active) ? s.active : tabs[0].id, split: tabs.some((t) => t.id === s.split) ? s.split : null };
    });
  }, [me]);
  // The active tab determines the URL (switching tabs is a history step, so Back returns to the previous tab).
  useEffect(() => { if (currentPath() !== activePath) history.pushState(null, "", activePath); }, [activePath]);
  // Hidden editors (OnlyOffice, draw.io) stay loaded; a resize lets them lay out again when shown.
  useEffect(() => { requestAnimationFrame(() => dispatchEvent(new Event("resize"))); }, [state.active, state.split]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (Object.values(dirtyRef.current).some(Boolean)) e.preventDefault(); };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, []);

  const goIn = useCallback((tabId: string, path: string) => {
    if (path === "/") return setHome(true);
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) }));
  }, []);
  const go = useCallback((path: string) => {
    if (path === "/") return setHome(true);
    const fromHome = homeRef.current;
    setHome(false);
    setState((s) => {
      const hit = fromHome ? s.tabs.find((t) => t.path === path) : undefined; // coming back from the overview: reuse an open tab
      return hit ? { ...s, active: hit.id } : { ...s, tabs: s.tabs.map((t) => (t.id === s.active ? { ...t, path } : t)) };
    });
  }, []);
  const openTab = useCallback((path: string, activate = false) => {
    if (path === "/") return setHome(true);
    if (activate) setHome(false);
    setState((s) => {
      const tab: DocTab = { id: newTabId(), path };
      let tabs = [...s.tabs, tab];
      while (tabs.length > MAX_TABS) {
        const victim = tabs.find((t) => !t.pinned && t.id !== s.active && t.id !== tab.id && !dirtyRef.current[t.id]);
        if (!victim) break;
        tabs = tabs.filter((t) => t !== victim);
      }
      return { ...s, tabs, active: activate ? tab.id : s.active };
    });
  }, []);
  const activate = useCallback((id: string) => {
    setHome(false);
    // Activating the right half of a split view swaps the halves instead of ending the split.
    setState((s) => (s.active === id ? s : { ...s, active: id, split: s.split === id ? s.active : s.split }));
  }, []);
  const discard = (message: string) => confirmDialog({ title: "Ungespeicherte Änderungen verwerfen?", message, ok: "Verwerfen", danger: true });
  const closeTab = async (id: string) => {
    if (dirtyRef.current[id] && !(await discard("Dieser Tab hat ungespeicherte Änderungen."))) return;
    setState((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      let tabs = s.tabs.filter((t) => t.id !== id);
      if (!tabs.length) tabs = [{ id: newTabId(), path: "/wiki" }];
      const active = s.active === id ? tabs[Math.min(i, tabs.length - 1)].id : s.active;
      return { tabs, active, split: s.split === id || s.split === active ? null : s.split };
    });
  };
  const closeOthers = async (id: string) => {
    const others = state.tabs.filter((t) => t.id !== id && !t.pinned);
    if (others.some((t) => dirtyRef.current[t.id]) && !(await discard("Andere Tabs haben ungespeicherte Änderungen."))) return;
    setState((s) => ({ tabs: s.tabs.filter((t) => t.id === id || t.pinned), active: id, split: null }));
  };
  const reorder = (dragged: string, before: string) => setState((s) => {
    const moved = s.tabs.find((t) => t.id === dragged)!;
    const rest = s.tabs.filter((t) => t.id !== dragged);
    rest.splice(rest.findIndex((t) => t.id === before), 0, moved);
    return { ...s, tabs: pinnedFirst(rest) };
  });
  const pin = (id: string) => setState((s) => ({ ...s, tabs: pinnedFirst(s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))) }));

  // Stable per-tab callbacks, so views can report unsaved changes without re-render loops.
  const dirtySetters = useRef(new Map<string, (d: boolean) => void>());
  const dirtySetter = (id: string) => {
    if (!dirtySetters.current.has(id)) {
      dirtySetters.current.set(id, (d: boolean) => setDirtyMap((m) => (!!m[id] === d ? m : { ...m, [id]: d })));
    }
    return dirtySetters.current.get(id)!;
  };

  // Ctrl/Cmd-click and middle click on internal links open an in-app tab instead of a browser tab.
  useEffect(() => {
    if (!user) return;
    const onClick = (e: MouseEvent) => {
      if (!wantsNewTab(e)) {
        // A link to a Findus page inside page text navigates inside the app instead of reloading.
        const a = (e.target as Element | null)?.closest?.(".prose a[href]") as HTMLAnchorElement | null;
        const href = a?.getAttribute("href") ?? "";
        if (e.type === "click" && e.button === 0 && a && !a.hasAttribute("download") && /^\/n\/[0-9a-f-]{36}$/i.test(href)) { e.preventDefault(); go(href); }
        return;
      }
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const href = a?.getAttribute("href") ?? "";
      if (!a || a.hasAttribute("download") || a.target || !TAB_PATH.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      openTab(href.replace(/^\/karte/, "/netzwerk"));
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => { document.removeEventListener("click", onClick, true); document.removeEventListener("auxclick", onClick, true); };
  }, [user, openTab, go]);

  const changed = useCallback(() => setTreeVersion((v) => v + 1), []);

  if (!me) return null;
  // Logged-out visitors get nothing but the login; the public FAQ lives in its own portal (/hilfe).
  if (anon) return linkChecked ? <Login onLogin={applyMe} /> : null;
  // The start admin sees nothing but this until the new password is set.
  if (me.must_change_password) return <ForcedPassword onDone={applyMe} onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); setMe({ authenticated: false }); }} />;
  // Anonymous visitors only get the wiki tree with the public areas, and a single view without the tab bar.
  const rawSection = sectionOf(activePath, openId ? areaTab[openId] ?? lastTab.current : undefined);
  const section: Tab = (rawSection === "tasks" || rawSection === "map") && !me.features?.includes(rawSection === "tasks" ? "tasks" : "network") ? "overview" : rawSection;
  lastTab.current = section === "admin" || section === "overview" || section === "tasks" || section === "map" || extensions.some((e) => e.id === section) ? lastTab.current : section;
  const tabs = tabsFor(me);
  const team = me.nav?.teams.find((t) => `team-${t.id}` === section);
  const selectedId = nodeIdOf(activePath);
  const split = !anon && state.split && state.split !== state.active && state.tabs.some((t) => t.id === state.split) ? state.split : null;
  const shown = (t: DocTab) => t.id === state.active || t.id === split;

  return (
    <div className={`${section === "overview" ? "layout full" : "layout"}${anon || section === "overview" ? "" : " with-tabs"}`} style={{ "--side-w": `${sideW}px` } as CSSProperties}>
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go("/"); }}><img src="/findus.svg" alt="" className="logo" />Findus</a>
        <TabNav tabs={tabs} section={section} go={go} />
        <Search onSelect={(id) => go(`/n/${id}`)} onOpenTab={anon ? undefined : (path) => openTab(path)} teams={me.nav?.teams ?? []} hasPrivate={!!me.nav?.private} />
        <ProfileMenu me={me} theme={theme} onTheme={chooseTheme} onMe={applyMe}
          onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); setMe({ authenticated: false }); }} />
      </header>
      {(section === "wiki" || section === "faq" || section === "private" || team) && (
        <nav className="sidebar" aria-label={team ? teamLabel(team.name) : section === "private" ? "Privat" : section === "faq" ? "Alle Anwender" : "Ordnerbaum"}>
          <Tree key={section} selected={selectedId} version={treeVersion} onChanged={changed} user={user ?? ""} canExport={!!me.can_download}
            onSelect={(id) => go(id ? `/n/${id}` : team ? `/n/${team.area}` : section === "private" ? `/n/${me.nav?.private}` : section === "faq" ? "/anwender" : "/wiki")}
            rootId={team?.area ?? (section === "private" ? me.nav?.private ?? undefined : undefined)} head={team ? teamLabel(team.name) : section === "private" ? "Mein Bereich" : undefined} incoming={team ? "team" : section === "private" ? "user" : undefined} scope={section === "faq" ? "public" : section === "wiki" ? "other" : undefined}
            canCreateRoot={team ? team.write : section === "private" ? !!me.nav?.private : section === "faq" ? false : !!me.can_create_area}
            onOpenTab={(id) => openTab(`/n/${id}`)} />
        </nav>
      )}
      {section === "map" && (
        <nav className="sidebar" aria-label="Netzwerk">
          <Tree space="karte" selected={selectedId} onSelect={(id) => go(id ? `/netzwerk/${id}` : "/netzwerk")} version={treeVersion}
            onChanged={changed} canCreateRoot={!!me.can_create_area} onOpenTab={(id) => openTab(`/netzwerk/${id}`)} />
        </nav>
      )}
      {section === "admin" && (
        <nav className="sidebar" aria-label="Verwaltung"><AdminNav me={me} path={activePath} go={go} /></nav>
      )}
      {(section === "wiki" || section === "faq" || section === "private" || team || section === "map" || section === "admin") && <SideHandle width={sideW} onChange={changeSide} />}
      <div className="workspace">
        {!anon && section !== "overview" && (
          <TabBar state={{ ...state, split }} dirty={dirty} version={treeVersion} onActivate={activate} onClose={closeTab}
            onCloseOthers={closeOthers} onReorder={reorder} onPin={pin} onNew={() => openTab("/wiki", true)}
            onSplit={(id) => setState((s) => ({ ...s, split: id }))} />
        )}
      <main className={split ? "content split" : "content"}>
        {home && !anon && (
          <section className="tab-pane"><View path="/" anon={false} me={me} go={go} changed={changed} /></section>
        )}
        {(anon ? [activeTab] : state.tabs).map((t) => (
          // Every open tab stays mounted (hidden) so editors, OnlyOffice and draw.io keep their state.
          <section key={t.id} className="tab-pane" hidden={!shown(t) || home} style={{ order: t.id === state.active ? 0 : 1 }}
            aria-label={t.id === split ? "Rechte Hälfte" : undefined}
            onPointerDownCapture={() => { if (t.id !== state.active) activate(t.id); }}>
            <TabContext.Provider value={{ setDirty: dirtySetter(t.id) }}>
              <View path={t.path} anon={anon} me={me} go={(path) => goIn(t.id, path)} changed={changed} />
            </TabContext.Provider>
          </section>
        ))}
      </main>
      </div>
    </div>
  );
}

function View({ path, anon, me, go, changed }: { path: string; anon: boolean; me: Me; go: (path: string) => void; changed: () => void }) {
  const p = path.split("?")[0];
  const id = nodeIdOf(p);
  if (p.startsWith("/netzwerk") && !anon && me.features?.includes("network")) {
    return id ? <NetView key={id} id={id} onChanged={changed} search={path.split("?")[1] ?? ""} /> : (
      <>
        <h1>Netzwerk</h1>
        <p className="muted">Links eine Karte oder einen Netzplan wählen. Rechtsklick legt Ordner, Karten und Netzplan-Verknüpfungen an, Ziehen verschiebt.</p>
      </>
    );
  }
  if (p.startsWith("/verwaltung") && !anon) return <Admin me={me} path={path} go={go} />;
  const ext = extensions.find((e) => p.startsWith(e.path));
  if (ext && !anon && ext.show(me)) return <>{ext.render()}</>;
  if (p.startsWith("/aufgaben") && !anon && me.features?.includes("tasks")) return <><h1>Aufgaben</h1><TaskBoard /></>;
  if (p.startsWith("/n/") && id) return <NodeView key={id} id={id} onSelect={(nid) => go(nid ? `/n/${nid}` : "/wiki")} onChanged={changed} />;
  if (p.startsWith("/anwender")) return <Faq onSelect={(nid) => go(`/n/${nid}`)} />;
  if (p.startsWith("/wiki")) {
    return (
      <>
        <h1>Wiki</h1>
        <p className="muted">Bereiche außerhalb der Teams. Links den Ordnerbaum nutzen (Rechtsklick legt Neues an, Strg-Klick öffnet in einem neuen Tab).</p>
      </>
    );
  }
  const home = homeExtension(me);
  return (
    <>
      <h1>Übersicht</h1>
      {home?.render()}
      <div className="ov-grid">
        {me.features?.includes("tasks") && <section className="ov-box"><h2>Meine Aufgaben</h2><TaskBoard compact go={go} /></section>}
        <Recent />
        <section className="ov-box ov-wide"><Dashboard /></section>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <DialogHost />
  </StrictMode>,
);
