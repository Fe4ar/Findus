import { Fragment, useEffect, useState } from "react";
import { api, ApiError, Kind, NodeDetail, NodeSummary } from "./api";
import { wantsNewTab } from "./Tabs";
import { ask, confirmDialog, notify } from "./Dialog";
import { Icon } from "./Icons";
import { ImportDialog } from "./Import";
import { ShareDialog } from "./Share";
import { tr, trs } from "./i18n";

const EMOJI: Partial<Record<Kind, string>> = { file: "📎", map: "🗺️", link: "📐" };

export function KindIcon({ kind, size = 16 }: { kind: Kind; size?: number }) {
  return (
    <span className={`kind-icon k-${kind}`} aria-hidden="true">
      {kind === "area" || kind === "folder" ? <Icon name="folder" size={size} /> : kind === "page" ? <Icon name="fileText" size={size} />
        : <span style={{ fontSize: size * 0.95 }}>{EMOJI[kind]}</span>}
    </span>
  );
}

// Which folders are open is remembered per browser session (sessionStorage, per user) as a list of node ids: a fresh session starts
// with every folder closed, opening a folder never opens its sub folders by itself, and what the user opened earlier stays open.
let treeUser = "";
const openKey = () => `findus-tree-open:${treeUser}`;
function loadOpen(): Set<string> {
  try { return new Set(JSON.parse(sessionStorage.getItem(openKey()) ?? "[]")); } catch { return new Set(); }
}
function storeOpen(id: string, open: boolean) {
  try {
    const s = loadOpen();
    open ? s.add(id) : s.delete(id);
    sessionStorage.setItem(openKey(), JSON.stringify([...s]));
  } catch { /* storage unavailable */ }
}
const isContainer = (k: Kind) => k === "area" || k === "folder";
// The item being dragged and its folder: during dragover only the data types are readable, so the Tree keeps this itself.
let dragging: { id: string; parent: string | null } | null = null;

interface Menu {
  x: number;
  y: number;
  node: NodeSummary | null; // null = empty space (new area, or folder/map in the map tree)
  up?: string | null | undefined; // sibling to put the node in front of for "Nach oben" (undefined = already first)
  down?: string | null | undefined; // same for "Nach unten" (null = last; undefined = already last)
}

// Separate trees: the wiki and the network tab, both with areas at the top (network: maps and folders may also sit there).
export type Space = "wiki" | "karte";
const CHILD_KINDS: Record<Space, Kind[]> = { wiki: ["folder", "page"], karte: ["folder", "page", "map", "link"] };
const ROOT_KINDS: Record<Space, Kind[]> = { wiki: ["area"], karte: ["area"] };
const NEW_LABEL: Record<Kind, string> = {
  area: "Neuer Bereich", folder: "Neuer Ordner", page: "Neue Seite", file: "", map: "Neue Karte", link: "Netzplan verknüpfen",
};

interface TreeProps {
  selected: string | null;
  onSelect: (id: string | null) => void;
  version: number;
  onChanged: () => void;
  space?: Space;
  canCreateRoot?: boolean;
  onOpenTab?: (id: string) => void; // Ctrl/middle click and "In neuem Tab öffnen"
  user?: string;
  canExport?: boolean;
  rootId?: string; // show the content of this area (a team's) instead of the list of areas
  incoming?: "team" | "user"; // which folders shared with me to list below the tree: from other teams, or for me alone (Privat)
  head?: string; // a team's tree starts with its name (team icon, visibility, "+" menu) instead of big buttons at the bottom
  scope?: "public" | "other"; // list only the public areas ("Alle Anwender") or the areas outside every team
}

export function Tree({ selected, onSelect, version, onChanged, space = "wiki", canCreateRoot = true, onOpenTab, user = "", canExport = false, rootId, scope, head, incoming: incomingKind }: TreeProps) {
  treeUser = user;
  // With rootId the top level holds the area's folders and pages, so new items go into that area.
  const rootNode = rootId ? ({ id: rootId, kind: "area" } as NodeSummary) : null;
  const topKinds = rootId ? CHILD_KINDS[space] : space === "karte" ? (["area", "folder", "page", "map", "link"] as Kind[]) : ROOT_KINDS[space];
  const [menu, setMenu] = useState<Menu | null>(null);
  const [importing, setImporting] = useState<NodeSummary | null>(null);
  const [sharing, setSharing] = useState<NodeSummary | null>(null);
  const [plus, setPlus] = useState<{ x: number; y: number } | null>(null);
  const privateHead = incomingKind === "user"; // the personal area gets the same head as a team ("Nur du" instead of "Nur IT")
  const [vis, setVis] = useState<NodeSummary["vis"]>();
  // The team head shows who may see the team's area ("Nur IT"), taken from the area's entry in the top-level list.
  useEffect(() => {
    if (!head || !rootId || privateHead) return;
    api<NodeSummary[]>("/api/tree?space=wiki").then((l) => setVis(l.find((n) => n.id === rootId)?.vis)).catch(() => undefined);
  }, [head, rootId, version]);
  const [incoming, setIncoming] = useState<NodeSummary[]>([]);
  const [reveal, setReveal] = useState(0); // the path to the selected page is opened (and only that path)
  useEffect(() => {
    if (!selected) return;
    let stale = false;
    api<NodeDetail>(`/api/nodes/${selected}`).then((n) => {
      if (stale) return;
      const path = (n.breadcrumb ?? []).map((b) => b.id).filter((id) => id !== selected);
      if (path.some((id) => !loadOpen().has(id))) { path.forEach((id) => storeOpen(id, true)); setReveal((v) => v + 1); }
    }).catch(() => undefined);
    return () => { stale = true; };
  }, [selected]);
  const [headDrop, setHeadDrop] = useState(false); // dragging over the team name: the item goes to the very top of the team
  // Folders other teams shared with the user's teams, below the team's own tree.
  useEffect(() => {
    if (!rootId) return;
    api<{ id: string; kind?: Kind; title: string; from_team: string; edit: boolean; to_user: boolean; can_leave?: boolean }[]>("/api/shares/incoming")
      .then((r) => setIncoming(r.filter((x) => (incomingKind === "user") === x.to_user).map((x) => ({ id: x.id, kind: x.kind ?? "folder", title: x.title, status: "published", position: 0, has_children: (x.kind ?? "folder") === "folder", writable: x.edit, from: x.from_team, received: x.from_team !== "Du (privat)", can_leave: x.can_leave }))))
      .catch(() => setIncoming([]));
  }, [rootId, version, incomingKind]);

  useEffect(() => {
    const close = () => { setMenu(null); setPlus(null); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
  }, []);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
      onChanged();
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen."));
    }
  }

  async function create(kind: Kind, parent: NodeSummary | null) {
    if (kind === "link") {
      const ref = await ask({ title: tr("Netzplan verknüpfen"), label: tr("Link oder ID der .drawio-Datei aus dem Wiki"), ok: tr("Verknüpfen") });
      const target = ref?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      if (!target) return;
      await run(async () => {
        const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, target, parent: parent?.id, space } });
        onSelect(n.id);
      });
      return;
    }
    const question = { area: tr("Neuer Bereich"), folder: tr("Neuer Ordner"), page: tr("Neue Seite"), file: "", map: tr("Neue Karte") }[kind];
    const title = await ask({ title: question, label: kind === "page" ? tr("Titel") : tr("Name"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (!title?.trim()) return;
    await run(async () => {
      const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, title: title.trim(), parent: parent?.id, space } });
      onSelect(n.id);
    });
  }

  const m = menu;
  const move = (id: string, target: string | null) => run(() => api(`/api/nodes/${id}`, { method: "PATCH", body: { parent: target } }));
  const reorder = (id: string, before: string | null, parent?: string | null, first?: boolean) =>
    run(() => api(`/api/nodes/${id}/reorder`, { method: "POST", body: { before, ...(parent ? { parent } : {}), ...(first ? { first: true } : {}) } }));
  return (
    <div
      className="tree"
      onContextMenu={(e) => {
        e.preventDefault();
        if (canCreateRoot) setMenu({ x: e.clientX, y: e.clientY, node: null });
      }}
      // In the map tree, dropping on empty space moves an item back to the top level.
      onDragOver={(e) => { if (space === "karte" && e.dataTransfer.types.includes("text/x-node")) e.preventDefault(); }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/x-node");
        if (space === "karte" && id) {
          e.preventDefault();
          move(id, null);
        }
      }}
    >
      {head && (
        <div className={`tree-head${selected === rootId ? " selected" : ""}${headDrop ? " drop" : ""}`}
          onDragOver={(e) => { if (rootId && dragging && e.dataTransfer.types.includes("text/x-node")) { e.preventDefault(); setHeadDrop(true); } }}
          onDragLeave={() => setHeadDrop(false)}
          onDrop={(e) => { setHeadDrop(false); const id = e.dataTransfer.getData("text/x-node"); if (rootId && id) { e.preventDefault(); reorder(id, null, rootId, true); } }}>
          <button className="tree-head-name" onClick={() => onSelect(null)} title={head}>
            <Icon name={privateHead ? "lock" : space === "karte" ? "tree" : "users"} size={16} /><span className="label-text">{head}</span>
          </button>
          {privateHead
            ? <span className="vis-badge vis-private" title={tr("Nur du siehst diesen Bereich")}>{tr("Nur du")}</span>
            : vis && vis.kind !== "public" && <span className={`vis-badge vis-${vis.kind}`} title={trs(vis.text)}>{trs(vis.badge)}</span>}
          {canExport && rootId && (
            <button className="tree-plus tree-export" aria-label={tr("Alles exportieren (ZIP)")} title={tr("Alle lesbaren Ordner, Seiten (als PDF) und Dateien als ZIP exportieren")}
              onClick={(e) => { e.stopPropagation(); void exportFolder({ id: rootId, title: head ?? "Export" } as NodeSummary); }}><Icon name="upload" size={14} /></button>
          )}
          {canCreateRoot && (
            <button className="tree-plus" aria-label={tr("Neu anlegen")} aria-haspopup="menu" aria-expanded={!!plus} title={tr("Neuer Ordner oder neue Seite")}
              onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu(null); setPlus(plus ? null : { x: r.left, y: r.bottom + 4 }); }}>+</button>
          )}
        </div>
      )}
      <Branch parent={rootId ?? null} scope={scope} space={space} depth={0} selected={selected} onSelect={onSelect} version={version} reveal={reveal}
        onMenu={setMenu} onMove={move} onReorder={reorder} onOpenTab={onOpenTab} dots={!!head} />
      {canCreateRoot && !head && topKinds.map((k) => (
        <button key={k} className="tree-add" onClick={() => create(k, rootNode)}>+ {tr(NEW_LABEL[k])}</button>
      ))}
      {plus && (
        <ul className="menu" role="menu" style={{ left: plus.x, top: plus.y }} onClick={(e) => e.stopPropagation()}>
          {topKinds.map((k) => <MenuItem key={k} label={tr(NEW_LABEL[k])} onClick={() => { setPlus(null); create(k, rootNode); }} />)}
        </ul>
      )}
      {incoming.length > 0 && (
        <ul className="branch" role="group" aria-label={incomingKind === "user" ? tr("Für mich freigegeben") : tr("Von anderen Teams")}>
          <li className="tree-heading" role="presentation">{incomingKind === "user" ? tr("Für mich freigegeben") : tr("Von anderen Teams")}</li>
          {incoming.map((n) => (
            <Item key={n.id} node={n} depth={0} selected={selected} onSelect={onSelect} version={version} onMenu={setMenu} onMove={move} onReorder={reorder} onOpenTab={onOpenTab} />
          ))}
        </ul>
      )}
      {m && (
        <ul className="menu" role="menu" style={{ left: m.x, top: m.y }} onClick={(e) => e.stopPropagation()}>
          {!m.node && topKinds.map((k) => (
            <MenuItem key={k} label={tr(NEW_LABEL[k])} onClick={() => { setMenu(null); create(k, rootNode); }} />
          ))}
          {m.node && onOpenTab && <MenuItem label={tr("In neuem Tab öffnen")} onClick={() => { setMenu(null); onOpenTab(m.node!.id); }} />}
          {m.node && m.node.writable !== false && isContainer(m.node.kind) && CHILD_KINDS[space].map((k) => (
            <MenuItem key={k} label={tr(NEW_LABEL[k])} onClick={() => { setMenu(null); create(k, m.node); }} />
          ))}
          {m.node && space === "wiki" && m.node.writable !== false && isContainer(m.node.kind) && (
            <MenuItem label={tr("Ordner importieren …")} onClick={() => { setMenu(null); setImporting(m.node); }} />
          )}
          {m.node && space === "wiki" && m.node.can_share && (
            <MenuItem label={tr("Freigeben …")} onClick={() => { setMenu(null); setSharing(m.node); }} />
          )}
          {m.node && space === "wiki" && canExport && isContainer(m.node.kind) && (
            <MenuItem label={tr("Ordner exportieren")} onClick={() => { setMenu(null); exportFolder(m.node!); }} />
          )}
          {m.node && m.node.writable !== false && (m.up !== undefined || m.down !== undefined) && (
            <>
              {m.up !== undefined && <MenuItem label={tr("Nach oben")} onClick={() => { setMenu(null); reorder(m.node!.id, m.up!); }} />}
              {m.down !== undefined && <MenuItem label={tr("Nach unten")} onClick={() => { setMenu(null); reorder(m.node!.id, m.down!); }} />}
            </>
          )}
          {m.node && m.node.can_leave && (
                <MenuItem label={tr("Entfernen")} danger onClick={async () => {
                  setMenu(null);
                  if (await confirmDialog({ title: tr("„{title}“ entfernen?", { title: m.node!.title }), message: tr("Die Freigabe wird für dich gelöst; der Inhalt bleibt unverändert beim Besitzer."), ok: tr("Entfernen"), danger: true }))
                    run(async () => { await api(`/api/shares/${m.node!.id}/leave`, { method: "POST" }); if (selected === m.node!.id) onSelect(null); });
                }} />
              )}
          {m.node && m.node.writable !== false && (
            <>
              <MenuItem label={tr("Umbenennen")} onClick={async () => {
                setMenu(null);
                const title = await ask({ title: tr("Umbenennen"), label: tr("Neuer Name"), initial: m.node!.title, ok: tr("Umbenennen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
                if (title?.trim()) run(() => api(`/api/nodes/${m.node!.id}`, { method: "PATCH", body: { title } }));
              }} />
              {!m.node.received && <MenuItem label={tr("Löschen")} danger onClick={async () => {
                setMenu(null);
                if (await confirmDialog({ title: tr("„{title}“ löschen?", { title: m.node!.title }), message: tr("Alles darunter wird mitgelöscht."), ok: tr("Löschen"), danger: true }))
                  run(async () => {
                    await api(`/api/nodes/${m.node!.id}`, { method: "DELETE" });
                    if (selected === m.node!.id) onSelect(null);
                  });
              }} />}
            </>
          )}
        </ul>
      )}
      {sharing && <ShareDialog node={sharing} onClose={() => setSharing(null)} onSaved={onChanged} />}
      {importing && <ImportDialog parent={importing.id} title={importing.title} onClose={() => setImporting(null)} onDone={onChanged} />}
    </div>
  );
}

export async function exportFolder(node: NodeSummary) {
  try {
    const res = await fetch(`/api/nodes/${node.id}/export-originals`, { credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || tr("Fehler {status}", { status: res.status }));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `${node.title}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    notify(e instanceof Error ? e.message : tr("Export fehlgeschlagen."));
  }
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <li role="menuitem">
      <button className={danger ? "danger" : ""} onClick={onClick}>{label}</button>
    </li>
  );
}

interface BranchProps {
  parent: string | null;
  scope?: "public" | "other";
  space?: Space;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  version: number;
  onMenu: (m: Menu) => void;
  onMove: (id: string, target: string | null) => void;
  onReorder: (id: string, before: string | null, parent?: string | null) => void;
  onOpenTab?: (id: string) => void;
  dots?: boolean; // visibility as a dot only (the team head already says who may see the area)
  reveal?: number; // bumped when the path to the selected page was opened (open folders are re-read)
}

function Branch({ parent, space = "wiki", scope, ...rest }: BranchProps) {
  const [items, setItems] = useState<NodeSummary[] | null>(null);
  useEffect(() => {
    api<NodeSummary[]>(`/api/tree?${parent ? `parent=${parent}` : `space=${space}${scope ? `&scope=${scope}` : ""}`}`).then(setItems).catch(() => setItems([]));
  }, [parent, space, scope, rest.version]);
  if (!items) return <div className="tree-loading" style={{ paddingLeft: rest.depth * 16 + 8 }}>…</div>;
  return (
    <ul className="branch" role={rest.depth === 0 ? "tree" : "group"}>
      {items.map((n, i) => {
        // Top level of the wiki: small-caps headings, "Dokumentation" for the normal areas and one per team area.
        const group = (x: NodeSummary) => (x.team ? (/^team\b/i.test(x.team) ? x.team : tr("Team {team}", { team: x.team })) : x.vis?.kind === "public" ? "FAQ" : tr("Dokumentation"));
        const head = !scope && rest.depth === 0 && space === "wiki" && n.kind === "area" && (i === 0 || group(items[i - 1]) !== group(n)) ? group(n) : null;
        return (
          <Fragment key={n.id}>
            {head && <li className="tree-heading" role="presentation">{head}</li>}
            <Item node={n} parentId={parent} up={i > 0 ? items[i - 1].id : undefined} down={i < items.length - 1 ? items[i + 2]?.id ?? null : undefined} next={items[i + 1]?.id ?? null} {...rest} />
          </Fragment>
        );
      })}
    </ul>
  );
}

function Item({ node, depth, selected, onSelect, version, onMenu, onMove, onReorder, onOpenTab, dots, parentId, up, down, next, reveal }: { node: NodeSummary; parentId?: string | null; up?: string | null; down?: string | null; next?: string | null } & Omit<BranchProps, "parent" | "space">) {
  const [open, setOpen] = useState(() => loadOpen().has(node.id));
  useEffect(() => { if (reveal && loadOpen().has(node.id)) setOpen(true); }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [dropTarget, setDropTarget] = useState(false);
  const [gap, setGap] = useState<"before" | "after" | null>(null); // dropping next to this row: reorder inside the folder
  const container = isContainer(node.kind);

  function toggle(v: boolean) {
    setOpen(v);
    storeOpen(node.id, v);
  }

  return (
    <li role="treeitem" aria-expanded={container ? open : undefined} aria-selected={selected === node.id}>
      <div
        className={`row${selected === node.id ? " selected" : ""}${dropTarget ? " drop" : ""}${gap ? ` gap-${gap}` : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        draggable={node.kind !== "area"}
        onDragStart={(e) => { e.dataTransfer.setData("text/x-node", node.id); dragging = { id: node.id, parent: parentId ?? null }; }}
        onDragEnd={() => { dragging = null; setGap(null); setDropTarget(false); }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("text/x-node")) return;
          // Same folder: the upper or lower quarter of a row (the whole row for a page) puts the item in front of / behind it;
          // the middle of a folder row moves the item into the folder.
          const r = e.currentTarget.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
          const sibling = !!dragging && dragging.id !== node.id && node.kind !== "area" && !!parentId; // next to a row of the same folder, of another folder or of a higher level
          if (sibling && (!container || y < 0.28 || y > 0.72)) { e.preventDefault(); e.stopPropagation(); setDropTarget(false); setGap(y < 0.5 ? "before" : "after"); }
          else if (container) { e.preventDefault(); setGap(null); setDropTarget(true); }
        }}
        onDragLeave={() => { setDropTarget(false); setGap(null); }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("text/x-node");
          const g = gap; setGap(null);
          if (g && id && id !== node.id) { e.preventDefault(); e.stopPropagation(); setDropTarget(false); const before = g === "before" ? node.id : next ?? null; if (before !== id) onReorder(id, before, parentId ?? null); return; }
          if (!container) return; // let it bubble to the tree (top-level drop in the map tree)
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(false);
          if (id && id !== node.id) {
            onMove(id, node.id);
            toggle(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (node.writable !== false || onOpenTab) onMenu({ x: e.clientX, y: e.clientY, node, up, down });
        }}
      >
        <button className={`twisty${open ? " open" : ""}`} aria-label={open ? tr("Zuklappen") : tr("Aufklappen")} tabIndex={-1}
          style={{ visibility: container && node.has_children ? "visible" : "hidden" }}
          onClick={() => toggle(!open)}>
          <Icon name="chevron" size={14} />
        </button>
        <button className="label"
          onClick={(e) => {
            if (onOpenTab && wantsNewTab(e)) return onOpenTab(node.id);
            onSelect(node.id);
            if (container) toggle(true);
          }}
          onMouseDown={(e) => { if (e.button === 1 && onOpenTab) e.preventDefault(); }} // no autoscroll on middle click
          onAuxClick={(e) => { if (e.button === 1 && onOpenTab) onOpenTab(node.id); }}>
          <KindIcon kind={node.kind} /><span className="label-text">{node.title}</span>
          {node.status === "draft" && <span className="badge">{tr("Entwurf")}</span>}
          {node.from && <small className="muted share-from">{tr("von")}{" "}{node.from}</small>}
        </button>
        {node.shared && node.shared.length > 0 && (
          <span className="share-mark" tabIndex={0} role="img" title={tr("Freigegeben an: {v}", { v: node.shared.join(", ") })}
            aria-label={tr("Freigegeben an: {v}", { v: node.shared.join(", ") })}><Icon name="share" size={12} /></span>
        )}
        {node.vis && node.vis.kind !== "public" && !node.shared?.length && (depth === 0 && !dots
          ? <span className={`vis-badge vis-${node.vis.kind}`} title={trs(node.vis.text)}>{trs(node.vis.badge)}</span>
          // Below the top level only a dot with a tooltip, so the folder name keeps its room.
          : <span className={`vis-dot vis-${node.vis.kind}`} title={trs(node.vis.text)} role="img" aria-label={trs(node.vis.text)} />)}
      </div>
      {container && open && (
        <Branch parent={node.id} depth={depth + 1} selected={selected} onSelect={onSelect} version={version} reveal={reveal}
          onMenu={onMenu} onMove={onMove} onReorder={onReorder} onOpenTab={onOpenTab} dots={dots} />
      )}
    </li>
  );
}
