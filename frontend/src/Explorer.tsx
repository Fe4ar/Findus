import { DragEvent, KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, formatDate, formatSize, Kind, NodeDetail, NodeSummary } from "./api";
import { ask, confirmDialog, notify } from "./Dialog";
import { Icon } from "./Icons";
import { ImportDialog } from "./Import";
import { uploadFile } from "./FileView";
import { KindIcon } from "./Tree";
import { tr } from "./i18n";

// "Klassisch": the wiki as a file-manager style folder view (path bar, big icons or a sortable list, multi-select, drag and drop to move).
// It shows the direct level of one folder only; opening a folder replaces the view (the URL changes, so the browser's back button works).

interface Row extends NodeSummary { updated_at?: string; updated_by?: string | null; size?: number | null }
type Layout = "icons" | "list";
type SortKey = "title" | "kind" | "updated_at" | "updated_by";
const LAYOUT_KEY = "findus-explorer-layout";
const KIND_LABEL = (k: Kind) => ({ area: tr("Bereich"), folder: tr("Ordner"), page: tr("Seite"), file: tr("Datei"), map: tr("Karte"), link: tr("Netzplan") }[k]);

export function Explorer({ node, onSelect, onChanged, onTree }: {
  node: NodeDetail | null; // null = the list of areas
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  onTree?: () => void; // switch back to the tree view
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [layout, setLayout] = useState<Layout>(() => { try { return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "icons"; } catch { return "icons"; } });
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null); // drop target (row id or breadcrumb id)
  const [menu, setMenu] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const writable = !!node?.permissions.write;

  const load = useCallback(() => {
    const url = node ? `/api/tree?parent=${node.id}&details=1` : "/api/tree?space=wiki&scope=other&details=1";
    return api<Row[]>(url).then((r) => { setRows(r); setSel(new Set()); }).catch(() => setRows([]));
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); setQ(""); load(); }, [load]);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* not remembered */ } }, [layout]);
  const changed = () => { onChanged(); void load(); };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (rows ?? []).filter((r) => !needle || r.title.toLowerCase().includes(needle));
    const isDir = (r: Row) => (r.kind === "folder" || r.kind === "area" ? 0 : 1);
    if (layout === "icons" && sort.key === "title" && sort.dir === 1 && !needle) return [...list].sort((a, b) => isDir(a) - isDir(b) || a.position - b.position);
    const val = (r: Row) => (sort.key === "kind" ? KIND_LABEL(r.kind) : sort.key === "updated_at" ? r.updated_at ?? "" : sort.key === "updated_by" ? r.updated_by ?? "" : r.title.toLowerCase());
    return [...list].sort((a, b) => isDir(a) - isDir(b) || (val(a) < val(b) ? -sort.dir : val(a) > val(b) ? sort.dir : 0));
  }, [rows, q, sort, layout]);

  const open = (r: Row) => onSelect(r.id);
  const up = () => { if (node?.parent) onSelect(node.parent); };
  const canUp = !!node?.parent;

  // --- selection: click, Ctrl/Cmd-click toggles, Shift-click selects a range
  const pick = (r: Row, e: MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey && anchor) {
      const ids = shown.map((x) => x.id), a = ids.indexOf(anchor), b = ids.indexOf(r.id);
      if (a >= 0 && b >= 0) { setSel(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1))); return; }
    }
    if (e.ctrlKey || e.metaKey) { const n = new Set(sel); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setSel(n); setAnchor(r.id); return; }
    setSel(new Set([r.id])); setAnchor(r.id);
  };
  const selected = shown.filter((r) => sel.has(r.id));
  const mayChange = selected.length > 0 && selected.every((r) => r.writable !== false && r.kind !== "area");

  async function create(kind: "folder" | "page") {
    if (!node) return;
    setMenu(false);
    const title = await ask({ title: kind === "folder" ? tr("Neuer Ordner") : tr("Neue Seite"), label: kind === "folder" ? tr("Name") : tr("Titel"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (!title?.trim()) return;
    try { await api("/api/nodes", { method: "POST", body: { kind, title: title.trim(), parent: node.id } }); changed(); }
    catch (e) { notify(e instanceof ApiError ? e.message : tr("Anlegen fehlgeschlagen.")); }
  }
  async function upload(files: File[]) {
    if (!node || !files.length) return;
    setMenu(false); setBusy(true);
    try { for (const f of files) await uploadFile(node.id, f); } catch (e) { notify(e instanceof ApiError ? e.message : tr("Upload fehlgeschlagen.")); }
    setBusy(false); changed();
  }
  async function rename() {
    const r = selected[0];
    if (!r) return;
    const title = await ask({ title: tr("Umbenennen"), label: tr("Name"), initial: r.title, ok: tr("Speichern"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (!title?.trim() || title === r.title) return;
    try { await api(`/api/nodes/${r.id}`, { method: "PATCH", body: { title: title.trim() } }); changed(); } catch (e) { notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen.")); }
  }
  async function remove() {
    if (!selected.length) return;
    const one = selected.length === 1;
    if (!(await confirmDialog({ title: one ? tr("„{title}“ löschen?", { title: selected[0].title }) : tr("{n} Einträge löschen?", { n: selected.length }), message: tr("Gelöschtes bleibt im Papierkorb, bis die Frist des Teams (Standard 40 Tage) abgelaufen ist. Danach wird es automatisch endgültig gelöscht."), ok: tr("Löschen"), danger: true }))) return;
    try { for (const r of selected) await api(`/api/nodes/${r.id}`, { method: "DELETE" }); } catch (e) { notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen.")); }
    changed();
  }

  // --- drag and drop: move the selection (or the dragged item) into a folder or onto a path segment
  const dragIds = useRef<string[]>([]);
  const dragStart = (r: Row, e: DragEvent) => {
    dragIds.current = sel.has(r.id) ? [...sel] : [r.id];
    if (!sel.has(r.id)) { setSel(new Set([r.id])); setAnchor(r.id); }
    e.dataTransfer.setData("text/x-explorer", dragIds.current.join(","));
    e.dataTransfer.effectAllowed = "move";
  };
  const canDrop = (targetId: string) => dragIds.current.length > 0 && !dragIds.current.includes(targetId);
  async function moveInto(targetId: string) {
    const ids = dragIds.current.filter((id) => id !== targetId);
    dragIds.current = [];
    setOver(null);
    if (!ids.length) return;
    let failed = 0;
    for (const id of ids) { try { await api(`/api/nodes/${id}`, { method: "PATCH", body: { parent: targetId } }); } catch (e) { failed++; if (failed === 1) notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen.")); } }
    changed();
  }
  const dropProps = (targetId: string) => ({
    onDragOver: (e: DragEvent) => { if (canDrop(targetId)) { e.preventDefault(); e.stopPropagation(); setOver(targetId); } },
    onDragLeave: () => setOver((o) => (o === targetId ? null : o)),
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); void moveInto(targetId); },
  });
  const isDir = (r: Row) => r.kind === "folder" || r.kind === "area";

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Enter" && selected.length === 1) open(selected[0]);
    else if (e.key === "Delete" && mayChange) void remove();
    else if (e.key === "F2" && mayChange && selected.length === 1) void rename();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSel(new Set(shown.map((r) => r.id))); }
    else if (e.key === "Backspace" && canUp) up();
    else if (e.key === "Escape") setSel(new Set());
  };
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (-s.dir) as 1 | -1 } : { key, dir: 1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");
  const crumbs = node?.breadcrumb ?? [];

  const item = (r: Row) => {
    const cls = `ex-item${sel.has(r.id) ? " selected" : ""}${over === r.id ? " drop" : ""}`;
    const common = {
      key: r.id, className: cls, draggable: r.writable !== false && r.kind !== "area", role: "option" as const, "aria-selected": sel.has(r.id), tabIndex: -1,
      onClick: (e: MouseEvent) => pick(r, e), onDoubleClick: () => open(r), onDragStart: (e: DragEvent) => dragStart(r, e), onDragEnd: () => setOver(null),
      ...(isDir(r) && r.writable !== false ? dropProps(r.id) : {}),
    };
    return layout === "icons" ? (
      <div {...common}>
        <KindIcon kind={r.kind} size={44} />
        <span className="ex-name" title={r.title}>{r.title}</span>
      </div>
    ) : (
      <div {...common} className={`${cls} ex-row`}>
        <span className="ex-col-name"><KindIcon kind={r.kind} size={18} /><span className="ex-name" title={r.title}>{r.title}</span></span>
        <span className="ex-col muted">{KIND_LABEL(r.kind)}{r.size != null ? ` · ${formatSize(r.size)}` : ""}</span>
        <span className="ex-col muted">{r.updated_at ? formatDate(r.updated_at) : ""}</span>
        <span className="ex-col muted">{r.updated_by ?? ""}</span>
      </div>
    );
  };

  return (
    <div className="explorer" ref={box} tabIndex={0} onKeyDown={onKey} onClick={() => { setSel(new Set()); setMenu(false); }}
      onDragOver={(e) => { if (writable && node && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { if (writable && e.dataTransfer.files.length) { e.preventDefault(); void upload([...e.dataTransfer.files]); } }}>
      <div className="ex-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="icon-btn" title={tr("Zurück")} aria-label={tr("Zurück")} onClick={() => history.back()}><Icon name="arrowLeft" /></button>
        <button type="button" className="icon-btn" title={tr("Eine Ebene höher")} aria-label={tr("Eine Ebene höher")} disabled={!canUp} onClick={up}><Icon name="arrowUp" /></button>
        <nav className="ex-path" aria-label={tr("Pfad")}>
          <button type="button" className={`ex-crumb${!node ? " current" : ""}`} onClick={() => onSelect(null)}>{tr("Wiki")}</button>
          {crumbs.map((b) => (
            <span key={b.id} className="ex-crumb-wrap"><span aria-hidden="true">›</span>
              <button type="button" className={`ex-crumb${over === b.id ? " drop" : ""}${b.id === node?.id ? " current" : ""}`} onClick={() => onSelect(b.id)} {...(b.id === node?.id ? {} : dropProps(b.id))}>{b.title}</button>
            </span>
          ))}
          {node && !crumbs.some((b) => b.id === node.id) && <span className="ex-crumb-wrap"><span aria-hidden="true">›</span><span className="ex-crumb current">{node.title}</span></span>}
        </nav>
        <input type="search" className="ex-search" placeholder={tr("In diesem Ordner suchen …")} aria-label={tr("In diesem Ordner suchen")} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ex-layout" role="group" aria-label={tr("Darstellung")}>
          <button type="button" className="icon-btn" aria-pressed={layout === "icons"} title={tr("Große Symbole")} aria-label={tr("Große Symbole")} onClick={() => setLayout("icons")}><Icon name="grid" /></button>
          <button type="button" className="icon-btn" aria-pressed={layout === "list"} title={tr("Liste")} aria-label={tr("Liste")} onClick={() => setLayout("list")}><Icon name="list" /></button>
        </span>
        {writable && (
          <span className="ex-new">
            <button type="button" className="primary" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="plus" size={14} /> {tr("Neu")}</button>
            {menu && (
              <ul className="menu" role="menu">
                <li><button role="menuitem" onClick={() => void create("folder")}>{tr("Ordner")}</button></li>
                <li><button role="menuitem" onClick={() => void create("page")}>{tr("Seite")}</button></li>
                <li><label role="menuitem" className="menu-label">{busy ? tr("Lade hoch …") : tr("Datei hochladen")}<input type="file" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; void upload(f); }} /></label></li>
                <li><button role="menuitem" onClick={() => { setMenu(false); setImporting(true); }}>{tr("Ordner importieren …")}</button></li>
              </ul>
            )}
          </span>
        )}
        {onTree && <button type="button" className="icon-btn" title={tr("Zur Baumansicht wechseln")} aria-label={tr("Zur Baumansicht wechseln")} onClick={onTree}><Icon name="tree" /></button>}
      </div>
      {/* Always present (fixed height), so selecting something never moves the items under the pointer (double click!). */}
      <div className="ex-actions" onClick={(e) => e.stopPropagation()} role="toolbar" aria-label={tr("Auswahl")}>
        {selected.length === 0 ? <span className="muted small">{tr("Doppelklick öffnet, Strg- oder Umschalt-Klick wählt mehrere, Ziehen verschiebt.")}</span> : (
          <>
            <span className="muted">{tr("{n} ausgewählt", { n: selected.length })}</span>
            {selected.length === 1 && <button type="button" onClick={() => open(selected[0])}>{tr("Öffnen")}</button>}
            {mayChange && selected.length === 1 && <button type="button" onClick={() => void rename()}>{tr("Umbenennen")}</button>}
            {mayChange && <button type="button" className="danger" onClick={() => void remove()}>{tr("Löschen")}</button>}
          </>
        )}
      </div>
      {rows === null ? <p className="muted">{tr("Lade …")}</p> : !shown.length ? <p className="muted ex-empty">{q ? tr("Nichts gefunden.") : tr("Noch leer.")}{writable && !q ? " " + tr("Ziehe Dateien hierher oder nutze „Neu“.") : ""}</p> : layout === "icons" ? (
        <div className="ex-grid" role="listbox" aria-multiselectable="true" aria-label={node?.title ?? tr("Wiki")}>{shown.map(item)}</div>
      ) : (
        <div className="ex-list" role="listbox" aria-multiselectable="true" aria-label={node?.title ?? tr("Wiki")}>
          <div className="ex-row ex-head" role="presentation" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="ex-col-name" onClick={() => sortBy("title")}>{tr("Name")}{arrow("title")}</button>
            <button type="button" className="ex-col" onClick={() => sortBy("kind")}>{tr("Typ")}{arrow("kind")}</button>
            <button type="button" className="ex-col" onClick={() => sortBy("updated_at")}>{tr("Geändert")}{arrow("updated_at")}</button>
            <button type="button" className="ex-col" onClick={() => sortBy("updated_by")}>{tr("Von")}{arrow("updated_by")}</button>
          </div>
          {shown.map(item)}
        </div>
      )}
      {importing && node && <ImportDialog parent={node.id} title={node.title} onClose={() => setImporting(false)} onDone={changed} />}
    </div>
  );
}
