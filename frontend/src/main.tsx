import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, Me, Theme } from "./api";
import { Tree } from "./Tree";
import { confirmDialog, DialogHost } from "./Dialog";
import { NodeView } from "./NodeView";
import { Dashboard, Recent } from "./Dashboard";
import { Admin, AdminNav } from "./Admin";
import { Faq } from "./Faq";
import { Tasks } from "./Tasks";
import { NetView } from "./Karte";
import { Search } from "./Search";
import {
  currentPath, DocTab, loadTabs, MAX_TABS, newTabId, nodeIdOf, pinnedFirst, saveTabs, TabBar, TabContext, TabState, wantsNewTab,
} from "./Tabs";
import { ProfileMenu, ThemeSwitch } from "./ProfileMenu";
import "./styles.css";

type Tab = "overview" | "wiki" | "map" | "admin";
// Top-level tabs. A new tab adds an entry here and a case in the content switch in App.
const TABS: { id: Tab; label: string; path: string }[] = [
  { id: "overview", label: "Übersicht", path: "/" },
  { id: "wiki", label: "Wiki", path: "/wiki" },
  { id: "map", label: "Netzwerk", path: "/netzwerk" },
];


function currentId() {
  return location.pathname.match(/^\/n\/([0-9a-f-]{36})/)?.[1] ?? null;
}

// The tab was called "Karte" before; old /karte links keep working.
if (location.pathname.startsWith("/karte")) {
  history.replaceState(null, "", location.pathname.replace(/^\/karte/, "/netzwerk") + location.search);
}



function sectionOf(path: string): Tab {
  const p = path.split("?")[0];
  if (p.startsWith("/n/") || p.startsWith("/wiki")) return "wiki";
  if (p.startsWith("/verwaltung")) return "admin";
  return p.startsWith("/netzwerk") ? "map" : "overview";
}

// Paths a Ctrl/middle click may open as an in-app tab; everything else (downloads, admin, editors) stays native.
const TAB_PATH = /^\/(?:$|n\/|wiki|netzwerk|karte|verwaltung)/;

function Login({ onLogin, onPublic }: { onLogin: (me: Me) => void; onPublic: () => void }) {
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
        <p><a href="/wiki" onClick={(e) => { e.preventDefault(); onPublic(); }}>FAQ für Anwender ohne Anmeldung lesen</a></p>
      </form>
    </main>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<TabState>({ tabs: [{ id: "start", path: currentPath() }], active: "start", split: null });
  const [dirty, setDirtyMap] = useState<Record<string, boolean>>({});
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  // Bumped after any change so the tree reloads the affected branches.
  const [treeVersion, setTreeVersion] = useState(0);
  // index.html applies the stored theme before the first paint; the account setting wins once /me is loaded.
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
  // Logged out: login form first; shared links to pages (/n/<id>) open the public view directly.
  const [publicView, setPublicView] = useState(!!currentId() || location.pathname.startsWith("/wiki"));

  const anon = !!me && !me.authenticated;
  const user = me?.authenticated ? me.username ?? "" : null;
  const activeTab = state.tabs.find((t) => t.id === state.active) ?? state.tabs[0];
  const activePath = activeTab.path;

  useEffect(() => {
    api<Me>("/api/auth/me").then(applyMe);
    // Back/forward: show that URL in its tab if one has it, otherwise in the active tab.
    const onPop = () => {
      const path = currentPath();
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
    setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) }));
  }, []);
  const go = useCallback((path: string) => setState((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === s.active ? { ...t, path } : t)) })), []);
  const openTab = useCallback((path: string, activate = false) => {
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
    // Activating the right half of a split view swaps the halves instead of ending the split.
    setState((s) => (s.active === id ? s : { ...s, active: id, split: s.split === id ? s.active : s.split }));
  }, []);
  const discard = (message: string) => confirmDialog({ title: "Ungespeicherte Änderungen verwerfen?", message, ok: "Verwerfen", danger: true });
  const closeTab = async (id: string) => {
    if (dirtyRef.current[id] && !(await discard("Dieser Tab hat ungespeicherte Änderungen."))) return;
    setState((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      let tabs = s.tabs.filter((t) => t.id !== id);
      if (!tabs.length) tabs = [{ id: newTabId(), path: "/" }];
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
      if (!wantsNewTab(e)) return;
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
  }, [user, openTab]);

  const changed = useCallback(() => setTreeVersion((v) => v + 1), []);

  if (!me) return null;
  if (anon && !publicView) return <Login onLogin={applyMe} onPublic={() => { setPublicView(true); go("/wiki"); }} />;
  // Anonymous visitors only get the wiki tree with the public areas, and a single view without the tab bar.
  const section: Tab = anon ? "wiki" : sectionOf(activePath);
  const selectedId = nodeIdOf(activePath);
  const split = !anon && state.split && state.split !== state.active && state.tabs.some((t) => t.id === state.split) ? state.split : null;
  const shown = (t: DocTab) => t.id === state.active || t.id === split;

  return (
    <div className={`${section === "overview" ? "layout full" : "layout"}${anon ? "" : " with-tabs"}`}>
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); go("/"); }}><img src="/findus.svg" alt="" className="logo" />Findus</a>
        {!anon && <nav className="tabs" aria-label="Bereiche">
          {TABS.map((t) => (
            <a key={t.id} href={t.path} className="tab" aria-current={section === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); go(t.path); }}>{t.label}</a>
          ))}
        </nav>}
        <span className="spacer" />
        <Search onSelect={(id) => go(`/n/${id}`)} onOpenTab={anon ? undefined : (path) => openTab(path)} />
        {anon ? (
          <>
            <ThemeSwitch theme={theme} onTheme={chooseTheme} />
            <button className="primary" onClick={() => setPublicView(false)}>Anmelden</button>
          </>
        ) : (
          <ProfileMenu me={me} theme={theme} onTheme={chooseTheme}
            onLogout={async () => { await api("/api/auth/logout", { method: "POST" }); setMe({ authenticated: false }); }} />
        )}
      </header>
      {section === "wiki" && (
        <nav className="sidebar" aria-label="Ordnerbaum">
          <Tree selected={selectedId} onSelect={(id) => go(id ? `/n/${id}` : "/wiki")} version={treeVersion} onChanged={changed}
            canCreateRoot={!!me.can_create_area} onOpenTab={anon ? undefined : (id) => openTab(`/n/${id}`)} user={user ?? ""} />
          {!anon && (
            <div className="sidebar-foot">
              <a href="/verwaltung" onClick={(e) => { e.preventDefault(); dispatchEvent(new Event("findus-settings")); }}>Mein Konto</a> · <a href="/wiki" onClick={(e) => { e.preventDefault(); go("/wiki"); }}>Hilfe</a>
            </div>
          )}
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
      <div className="workspace">
        {!anon && (
          <TabBar state={{ ...state, split }} dirty={dirty} version={treeVersion} onActivate={activate} onClose={closeTab}
            onCloseOthers={closeOthers} onReorder={reorder} onPin={pin} onNew={() => openTab("/", true)}
            onSplit={(id) => setState((s) => ({ ...s, split: id }))} />
        )}
      <main className={split ? "content split" : "content"}>
        {(anon ? [activeTab] : state.tabs).map((t) => (
          // Every open tab stays mounted (hidden) so editors, OnlyOffice and draw.io keep their state.
          <section key={t.id} className="tab-pane" hidden={!shown(t)} style={{ order: t.id === state.active ? 0 : 1 }}
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
  if (p.startsWith("/netzwerk") && !anon) {
    return id ? <NetView key={id} id={id} onChanged={changed} search={path.split("?")[1] ?? ""} /> : (
      <>
        <h1>Netzwerk</h1>
        <p className="muted">Links eine Karte oder einen Netzplan wählen. Rechtsklick legt Ordner, Karten und Netzplan-Verknüpfungen an, Ziehen verschiebt.</p>
      </>
    );
  }
  if (p.startsWith("/verwaltung") && !anon) return <Admin me={me} path={path} go={go} />;
  if (p.startsWith("/n/") && id) return <NodeView key={id} id={id} onSelect={(nid) => go(nid ? `/n/${nid}` : "/wiki")} onChanged={changed} />;
  if (anon && !id) return <Faq onSelect={(nid) => go(`/n/${nid}`)} />;
  if (p.startsWith("/wiki") || anon) {
    return (
      <>
        <h1>Wiki</h1>
        <p className="muted">{anon ? "Links die öffentlichen Bereiche. Zum Bearbeiten bitte anmelden." : "Links den Ordnerbaum nutzen (Rechtsklick legt Neues an, Strg-Klick öffnet in einem neuen Tab)."}</p>
      </>
    );
  }
  return (
    <>
      <h1>Übersicht</h1>
      {me.can_overview && <><h2>Aktuelle Aufgaben</h2><Tasks /></>}
      <Recent />
      <Dashboard />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <DialogHost />
  </StrictMode>,
);
