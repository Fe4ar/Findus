import { useEffect, useState } from "react";
import { api, ApiError, Kind, NodeSummary } from "./api";

const ICONS: Record<Kind, string> = { area: "▣", folder: "📁", page: "📄", file: "📎", map: "🗺️", link: "📐" };
const isContainer = (k: Kind) => k === "area" || k === "folder";

interface Menu {
  x: number;
  y: number;
  node: NodeSummary | null; // null = empty space (new area, or folder/map in the map tree)
}

// Separate trees: the wiki (areas at the top) and the maps of the Karte tab (folders and maps, any level).
export type Space = "wiki" | "karte";
const CHILD_KINDS: Record<Space, Kind[]> = { wiki: ["folder", "page"], karte: ["folder", "map", "link"] };
const ROOT_KINDS: Record<Space, Kind[]> = { wiki: ["area"], karte: ["folder", "map"] };
const NEW_LABEL: Record<Kind, string> = {
  area: "Neuer Bereich", folder: "Neuer Ordner", page: "Neue Seite", file: "", map: "Neue Karte", link: "Netzplan verknüpfen",
};

interface TreeProps {
  selected: string | null;
  onSelect: (id: string | null) => void;
  version: number;
  onChanged: () => void;
  space?: Space;
}

export function Tree({ selected, onSelect, version, onChanged, space = "wiki" }: TreeProps) {
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
      alert(e instanceof ApiError ? e.message : "Aktion fehlgeschlagen.");
    }
  }

  async function create(kind: Kind, parent: NodeSummary | null) {
    if (kind === "link") {
      const ref = prompt("Netzplan verknüpfen: Link oder ID der .drawio-Datei aus dem Wiki:");
      const target = ref?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      if (!target) return;
      await run(async () => {
        const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, target, parent: parent?.id, space } });
        onSelect(n.id);
      });
      return;
    }
    const question = { area: "Name des neuen Bereichs:", folder: "Name des neuen Ordners:", page: "Titel der neuen Seite:", file: "",
      map: "Name der neuen Karte:" }[kind];
    const title = prompt(question);
    if (!title?.trim()) return;
    await run(async () => {
      const n = await api<NodeSummary>("/api/nodes", { method: "POST", body: { kind, title, parent: parent?.id, space } });
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
        setMenu({ x: e.clientX, y: e.clientY, node: null });
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
        onMenu={setMenu} onMove={move} />
      {ROOT_KINDS[space].map((k) => (
        <button key={k} className="tree-add" onClick={() => create(k, null)}>+ {NEW_LABEL[k]}</button>
      ))}
      {m && (
        <ul className="menu" role="menu" style={{ left: m.x, top: m.y }} onClick={(e) => e.stopPropagation()}>
          {!m.node && ROOT_KINDS[space].map((k) => (
            <MenuItem key={k} label={NEW_LABEL[k]} onClick={() => { setMenu(null); create(k, null); }} />
          ))}
          {m.node && isContainer(m.node.kind) && CHILD_KINDS[space].map((k) => (
            <MenuItem key={k} label={NEW_LABEL[k]} onClick={() => { setMenu(null); create(k, m.node); }} />
          ))}
          {m.node && (
            <>
              <MenuItem label="Umbenennen" onClick={() => {
                setMenu(null);
                const title = prompt("Neuer Name:", m.node!.title);
                if (title?.trim()) run(() => api(`/api/nodes/${m.node!.id}`, { method: "PATCH", body: { title } }));
              }} />
              <MenuItem label="Löschen" danger onClick={() => {
                setMenu(null);
                if (confirm(`„${m.node!.title}“ mit allem Inhalt löschen?`))
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

function Item({ node, depth, selected, onSelect, version, onMenu, onMove }: { node: NodeSummary } & Omit<BranchProps, "parent" | "space">) {
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
          onMenu({ x: e.clientX, y: e.clientY, node });
        }}
      >
        <button className="twisty" aria-label={open ? "Zuklappen" : "Aufklappen"} tabIndex={-1}
          style={{ visibility: container && node.has_children ? "visible" : "hidden" }}
          onClick={() => toggle(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <button className="label" onClick={() => { onSelect(node.id); if (container) toggle(true); }}>
          <span aria-hidden>{ICONS[node.kind]}</span> {node.title}
          {node.status === "draft" && <span className="badge">Entwurf</span>}
        </button>
      </div>
      {container && open && (
        <Branch parent={node.id} depth={depth + 1} selected={selected} onSelect={onSelect} version={version}
          onMenu={onMenu} onMove={onMove} />
      )}
    </li>
  );
}
