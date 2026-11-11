import { createContext, MouseEvent as ReactMouseEvent, useContext, useEffect, useState } from "react";
import { api, Kind, NodeDetail } from "./api";
import { extensions } from "./extensions";
import { Icon } from "./Icons";
import { tr } from "./i18n";

/** One open view in the in-app tab bar; its path is the URL it shows (e.g. /n/<id>, /netzwerk/<id>, /). */
export interface DocTab {
  id: string;
  path: string;
  pinned?: boolean;
}

export interface TabState {
  tabs: DocTab[];
  active: string;
  split: string | null; // second tab shown next to the active one
}

// shortcut: the oldest clean, unpinned background tab closes beyond this; raise it if people miss tabs
export const MAX_TABS = 20;
const ICONS: Partial<Record<Kind, string>> = { area: "▣", folder: "📁", page: "📄", file: "📎", map: "🗺️", link: "📐" };

export const newTabId = () => Math.random().toString(36).slice(2, 10);
export const currentPath = () => location.pathname + location.search;
export const nodeIdOf = (path: string) => path.match(/^\/(?:n|netzwerk)\/([0-9a-f-]{36})/)?.[1] ?? null;

/** Ctrl/Cmd-click or middle click opens in a new tab, as in the browser. */
export const wantsNewTab = (e: { ctrlKey: boolean; metaKey: boolean; button: number }) => e.ctrlKey || e.metaKey || e.button === 1;

const storageKey = (user: string) => `findus-tabs:${user}`;

export function loadTabs(user: string, path: string): TabState {
  let saved: TabState | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(user)) ?? "null");
  } catch {
    /* storage unavailable or broken: start fresh */
  }
  // "/" (the overview) is no tab any more; old saved ones are dropped.
  const tabs = (saved?.tabs ?? []).filter((t) => t && typeof t.path === "string" && t.path.startsWith("/") && t.path !== "/");
  if (path === "/") {
    const list = tabs.length ? tabs : [{ id: newTabId(), path: "/wiki" }];
    return { tabs: list, active: list.some((t) => t.id === saved?.active) ? saved!.active : list[0].id, split: null };
  }
  // The URL wins: reload or a shared link shows that view, in its existing tab if there is one.
  const hit = tabs.find((t) => t.path === path);
  if (hit) return { tabs, active: hit.id, split: saved?.split && saved.split !== hit.id && tabs.some((t) => t.id === saved!.split) ? saved.split : null };
  const tab = { id: newTabId(), path };
  return { tabs: [...tabs, tab], active: tab.id, split: null };
}

export function saveTabs(user: string, state: TabState) {
  try {
    localStorage.setItem(storageKey(user), JSON.stringify(state));
  } catch {
    /* storage unavailable: tabs just don't survive a reload */
  }
}

/** Pinned tabs always stay in front, otherwise the order is kept. */
export const pinnedFirst = (tabs: DocTab[]) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];

const titles = new Map<string, Promise<{ icon: string; title: string }>>();

function useTabLabel(path: string, version: number) {
  const [label, setLabel] = useState({ icon: "", title: "…" });
  useEffect(() => {
    const id = nodeIdOf(path);
    if (!id) {
      const p = path.split("?")[0];
      setLabel(p === "/" ? { icon: "🏠", title: tr("Übersicht") } : p.startsWith("/netzwerk") ? { icon: "🗺️", title: tr("Netzwerk") }
        : p.startsWith("/verwaltung") ? { icon: "gear", title: tr("Verwaltung") }
        : p.startsWith("/aufgaben") ? { icon: "✅", title: tr("Aufgaben") }
        : p.startsWith("/anwender") ? { icon: "❓", title: tr("Alle Anwender") }
        : extensions.find((e) => p.startsWith(e.path)) ? { icon: "", title: extensions.find((e) => p.startsWith(e.path))!.label }
        : { icon: "📚", title: tr("Wiki") });
      return;
    }
    const key = `${id}:${version}`; // a rename bumps the tree version, so titles follow
    if (!titles.has(key)) {
      titles.set(key, api<NodeDetail>(`/api/nodes/${id}`)
        .then((n) => ({ icon: ICONS[n.kind] ?? "📄", title: n.title }))
        .catch(() => ({ icon: "⚠️", title: tr("Nicht gefunden") })));
    }
    let alive = true;
    titles.get(key)!.then((l) => alive && setLabel(l));
    return () => { alive = false; };
  }, [path, version]);
  return label;
}

/** Lets a view mark its tab as having unsaved changes (closing then asks first). */
export const TabContext = createContext<{ setDirty: (dirty: boolean) => void }>({ setDirty: () => {} });

export function useDirty(dirty: boolean) {
  const { setDirty } = useContext(TabContext);
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
}

interface BarProps {
  state: TabState;
  dirty: Record<string, boolean>;
  version: number;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onReorder: (dragged: string, before: string) => void;
  onPin: (id: string) => void;
  onSplit: (id: string | null) => void;
  onNew: () => void;
}

export function TabBar(p: BarProps) {
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  useEffect(() => {
    const close = () => setMenu(null);
    addEventListener("click", close);
    addEventListener("keydown", close);
    return () => { removeEventListener("click", close); removeEventListener("keydown", close); };
  }, []);
  const tab = menu && p.state.tabs.find((t) => t.id === menu.id);
  return (
    <div className={`tabbar${p.state.tabs.length === 1 ? " single" : ""}`} role="tablist" aria-label={tr("Offene Tabs")}>
      {p.state.tabs.map((t) => (
        <TabButton key={t.id} tab={t} {...p} onMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, id: t.id }); }} />
      ))}
      <button className="tab-new" title={tr("Neuer Tab (Übersicht)")} aria-label={tr("Neuer Tab")} onClick={p.onNew}>+</button>
      {menu && tab && (
        <ul className="menu" role="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <li role="menuitem"><button onClick={() => { setMenu(null); p.onPin(tab.id); }}>{tab.pinned ? tr("Lösen") : tr("Anheften")}</button></li>
          {p.state.split === tab.id || (p.state.split && p.state.active === tab.id) ? (
            <li role="menuitem"><button onClick={() => { setMenu(null); p.onSplit(null); }}>{tr("Geteilte Ansicht beenden")}</button></li>
          ) : p.state.active !== tab.id && (
            <li role="menuitem"><button onClick={() => { setMenu(null); p.onSplit(tab.id); }}>{tr("Rechts daneben anzeigen")}</button></li>
          )}
          <li role="menuitem"><button onClick={() => { setMenu(null); p.onCloseOthers(tab.id); }}>{tr("Andere schließen")}</button></li>
          {!tab.pinned && <li role="menuitem"><button className="danger" onClick={() => { setMenu(null); p.onClose(tab.id); }}>{tr("Schließen")}</button></li>}
        </ul>
      )}
    </div>
  );
}

function TabButton({ tab, state, dirty, version, onActivate, onClose, onReorder, onMenu }: BarProps & {
  tab: DocTab;
  onMenu: (e: ReactMouseEvent) => void;
}) {
  const { icon, title } = useTabLabel(tab.path, version);
  const [over, setOver] = useState(false);
  const active = state.active === tab.id;
  const cls = ["doctab", active && "active", state.split === tab.id && "split", tab.pinned && "pinned", over && "drop"].filter(Boolean).join(" ");
  return (
    <div className={cls} role="tab" aria-selected={active} title={title} draggable
      onDragStart={(e) => e.dataTransfer.setData("text/x-tab", tab.id)}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("text/x-tab")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const d = e.dataTransfer.getData("text/x-tab"); if (d && d !== tab.id) onReorder(d, tab.id); }}
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} // no autoscroll on middle click
      onAuxClick={(e) => { if (e.button === 1 && !tab.pinned) onClose(tab.id); }}
      onContextMenu={onMenu}>
      <button className="doctab-label" onClick={() => onActivate(tab.id)}>
        <span aria-hidden="true">{tab.pinned ? "📌" : icon === "gear" ? <Icon name="gear" size={14} /> : icon}</span>
        {!tab.pinned && <span className="doctab-title">{title}</span>}
        {dirty[tab.id] && <span className="doctab-dirty" title={tr("Ungespeicherte Änderungen")} aria-label="ungespeichert">●</span>}
      </button>
      {!tab.pinned && <button className="doctab-close" aria-label={tr("{title} schließen", { title })} onClick={() => onClose(tab.id)}>×</button>}
    </div>
  );
}
