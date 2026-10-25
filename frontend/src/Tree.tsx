import { useEffect, useState } from "react";
import { api, ApiError, Kind, NodeSummary } from "./api";
import { wantsNewTab } from "./Tabs";
import { ask, confirmDialog, notify } from "./Dialog";

const ICONS: Record<Kind, string> = { area: "▣", folder: "📁", page: "📄", file: "📎", map: "🗺️", link: "📐" };
const isContainer = (k: Kind) => k === "area" || k === "folder";

interface Menu {
  x: number;
  y: number;
  node: NodeSummary | null; // null = empty space (new area, or folder/map in the map tree)
}

// Separate trees: the wiki and the network tab, both with areas at the top (network: maps and folders may also sit there).
export type Space = "wiki" | "karte";
const CHILD_KINDS: Record<Space, Kind[]> = { wiki: ["folder", "page"], karte: ["folder", "map", "link"] };
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
}

export function Tree({ selected, onSelect, version, onChanged, space = "wiki", canCreateRoot = true, onOpenTab }: TreeProps) {
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    const close = () => setMenu(null);
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
      notify(e instanceof ApiError ? e.message : "Aktion fehlgeschlagen.");
    }
  }

  async function create(kind: Kind, parent: NodeSummary | null) {
    if (kind === "link") {
      const ref = await ask({ title: "Netzplan verknüpfen", label: "Link oder ID der .drawio-Datei aus dem Wiki", ok: "Verknüpfen" });
      const target = ref?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      if (!target) return;
      await run(async () => {
        const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, target, parent: parent?.id, space } });
        onSelect(n.id);
      });
      return;
    }
    const question = { area: "Neuer Bereich", folder: "Neuer Ordner", page: "Neue Seite", file: "", map: "Neue Karte" }[kind];
    const title = await ask({ title: question, label: kind === "page" ? "Titel" : "Name", ok: "Anlegen", validate: (v) => (v.trim() ? null : "Bitte einen Namen eingeben.") });
    if (!title?.trim()) return;
    await run(async () => {
      const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, title: title.trim(), parent: parent?.id, space } });
      onSelect(n.id);
    });
  }

  const m = menu;
  const move = (id: string, target: string | null) => run(() => api(`/api/nodes/${id}`, { method: "PATCH", body: { parent: target } }));
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
      <Branch parent={null} space={space} depth={0} selected={selected} onSelect={onSelect} version={version}
        onMenu={setMenu} onMove={move} onOpenTab={onOpenTab} />
      {canCreateRoot && ROOT_KINDS[space].map((k) => (
        <button key={k} className="tree-add" onClick={() => create(k, null)}>+ {NEW_LABEL[k]}</button>
      ))}
      {m && (
        <ul className="menu" role="menu" style={{ left: m.x, top: m.y }} onClick={(e) => e.stopPropagation()}>
          {!m.node && ROOT_KINDS[space].map((k) => (
            <MenuItem key={k} label={NEW_LABEL[k]} onClick={() => { setMenu(null); create(k, null); }} />
          ))}
          {m.node && onOpenTab && <MenuItem label="In neuem Tab öffnen" onClick={() => { setMenu(null); onOpenTab(m.node!.id); }} />}
          {m.node && m.node.writable !== false && isContainer(m.node.kind) && CHILD_KINDS[space].map((k) => (
            <MenuItem key={k} label={NEW_LABEL[k]} onClick={() => { setMenu(null); create(k, m.node); }} />
          ))}
          {m.node && m.node.writable !== false && (
            <>
              <MenuItem label="Umbenennen" onClick={async () => {
                setMenu(null);
                const title = await ask({ title: "Umbenennen", label: "Neuer Name", initial: m.node!.title, ok: "Umbenennen", validate: (v) => (v.trim() ? null : "Bitte einen Namen eingeben.") });
                if (title?.trim()) run(() => api(`/api/nodes/${m.node!.id}`, { method: "PATCH", body: { title } }));
              }} />
              <MenuItem label="Löschen" danger onClick={async () => {
                setMenu(null);
                if (await confirmDialog({ title: `„${m.node!.title}“ löschen?`, message: "Alles darunter wird mitgelöscht.", ok: "Löschen", danger: true }))
                  run(async () => {
                    await api(`/api/nodes/${m.node!.id}`, { method: "DELETE" });
                    if (selected === m.node!.id) onSelect(null);
                  });
              }} />
            </>
          )}
        </ul>
      )}
    </div>
  );
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
  space?: Space;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  version: number;
  onMenu: (m: Menu) => void;
  onMove: (id: string, target: string | null) => void;
  onOpenTab?: (id: string) => void;
}

function Branch({ parent, space = "wiki", ...rest }: BranchProps) {
  const [items, setItems] = useState<NodeSummary[] | null>(null);
  useEffect(() => {
    api<NodeSummary[]>(`/api/tree?${parent ? `parent=${parent}` : `space=${space}`}`).then(setItems).catch(() => setItems([]));
  }, [parent, space, rest.version]);
  if (!items) return <div className="tree-loading" style={{ paddingLeft: rest.depth * 16 + 8 }}>…</div>;
  return (
    <ul className="branch" role={rest.depth === 0 ? "tree" : "group"}>
      {items.map((n) => <Item key={n.id} node={n} {...rest} />)}
    </ul>
  );
}

function Item({ node, depth, selected, onSelect, version, onMenu, onMove, onOpenTab }: { node: NodeSummary } & Omit<BranchProps, "parent" | "space">) {
  const [open, setOpen] = useState(() => sessionStorage.getItem(`open:${node.id}`) === "1");
  const [dropTarget, setDropTarget] = useState(false);
  const container = isContainer(node.kind);

  function toggle(v: boolean) {
    setOpen(v);
    try {
      sessionStorage.setItem(`open:${node.id}`, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }

  return (
    <li role="treeitem" aria-expanded={container ? open : undefined} aria-selected={selected === node.id}>
      <div
        className={`row${selected === node.id ? " selected" : ""}${dropTarget ? " drop" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        draggable={node.kind !== "area"}
        onDragStart={(e) => e.dataTransfer.setData("text/x-node", node.id)}
        onDragOver={(e) => {
          if (container && e.dataTransfer.types.includes("text/x-node")) {
            e.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={(e) => {
          if (!container) return; // let it bubble to the tree (top-level drop in the map tree)
          e.preventDefault();
          e.stopPropagation();
          setDropTarget(false);
          const id = e.dataTransfer.getData("text/x-node");
          if (id && id !== node.id) {
            onMove(id, node.id);
            toggle(true);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (node.writable !== false || onOpenTab) onMenu({ x: e.clientX, y: e.clientY, node });
        }}
      >
        <button className="twisty" aria-label={open ? "Zuklappen" : "Aufklappen"} tabIndex={-1}
          style={{ visibility: container && node.has_children ? "visible" : "hidden" }}
          onClick={() => toggle(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <button className="label"
          onClick={(e) => {
            if (onOpenTab && wantsNewTab(e)) return onOpenTab(node.id);
            onSelect(node.id);
            if (container) toggle(true);
          }}
          onMouseDown={(e) => { if (e.button === 1 && onOpenTab) e.preventDefault(); }} // no autoscroll on middle click
          onAuxClick={(e) => { if (e.button === 1 && onOpenTab) onOpenTab(node.id); }}>
          <span aria-hidden>{ICONS[node.kind]}</span> {node.title}
          {node.status === "draft" && <span className="badge">Entwurf</span>}
        </button>
      </div>
      {container && open && (
        <Branch parent={node.id} depth={depth + 1} selected={selected} onSelect={onSelect} version={version}
          onMenu={onMenu} onMove={onMove} onOpenTab={onOpenTab} />
      )}
    </li>
  );
}
