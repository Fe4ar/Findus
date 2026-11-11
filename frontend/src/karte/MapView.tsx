import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, NodeDetail } from "../api";
import { useDirty } from "../Tabs";
import { DrawioView } from "../Drawio";
import { ask, confirmDialog, notify } from "../Dialog";
import { Icon } from "../Icons";
import { ElType, El, PageRef, MapContent, TYPE_LABEL, newId, boxOf, CableMode, MEDIA, vlanColor } from "./model";
import { exportPng, exportSvg } from "./exportImage";
import { Canvas, heightOf } from "./Canvas";
import { Props } from "./Props";
import { MapHistory } from "./History";
import { RACK_TYPES, firstFree, rackTarget, Face } from "./rack";
import { DetailModal, DetailPanel, Facts } from "./Detail";
import { tr } from "../i18n";

const HISTORY = 100; // undo steps kept per editing session
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
let clipboard: El[] = []; // shared by all map tabs, so elements can be copied between maps

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
const matchesQuery = (e: El, q: string) => [e.name, e.ip, e.hostname, e.mac, e.model, e.serial, e.label, e.text]
  .some((v) => v?.toLowerCase().includes(q));

export function MapView({ id, onChanged, search = location.search }: { id: string; onChanged: () => void; search?: string }) {
  const params = new URLSearchParams(search); // the tab's own path, not the active URL
  const [pages, setPages] = useState<PageRef[]>([]);
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [draft, setDraftRaw] = useState<MapContent | null>(null);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string[]>(() => (params.get("el") ? [params.get("el")!] : []));
  const [tab, setTab] = useState<"map" | "history">("map");
  const [showDiagram, setShowDiagram] = useState(false);
  const [modal, setModal] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [cableMode, setCableMode] = useState<CableMode>("medium");
  const [face, setFace] = useState<Face>("front");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState("");
  // Undo/redo: snapshots of the draft; quick successive edits of the same element (dragging, typing) form one step.
  const past = useRef<MapContent[]>([]);
  const future = useRef<MapContent[]>([]);
  const last = useRef({ key: "", at: 0 });
  const [, bump] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  // Ctrl+wheel zooms the map; needs a non-passive listener to keep the browser from zooming the page.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.5, z * (ev.deltaY < 0 ? 1.1 : 1 / 1.1))));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  });

  const load = useCallback(() => api<NodeDetail>(`/api/nodes/${id}`).then(setNode).catch(() => setError(tr("Karte konnte nicht geladen werden."))), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const poll = () => api<Record<string, boolean>>(`/api/maps/${id}/status`).then(setStatus).catch(() => undefined);
    poll();
    const timer = setInterval(poll, 60_000); // matches the server-side check cache
    return () => clearInterval(timer);
  }, [id, node?.version]);

  const saved = node?.content as MapContent | null | undefined;
  const content: MapContent = draft ?? { ...saved, elements: saved?.elements ?? [] };
  const editing = draft !== null;
  useDirty(editing);
  const primary = selected[selected.length - 1] ?? null;
  const el = content.elements.find((e) => e.id === primary) ?? null;
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => new Set(q ? content.elements.filter((e) => matchesQuery(e, q)).map((e) => e.id) : []), [content, q]);

  const setDraft = useCallback((d: MapContent | null) => {
    past.current = []; future.current = []; last.current = { key: "", at: 0 };
    setDraftRaw(d);
  }, []);
  /** Every edit goes through here so it can be undone; key groups rapid edits into one step.
   * shortcut: history refs are touched inside state updaters, so StrictMode (dev only) records steps twice; fine in builds. */
  const edit = useCallback((fn: (d: MapContent) => MapContent, key = "") => {
    setDraftRaw((d) => {
      if (!d) return d;
      const now = Date.now();
      if (!key || key !== last.current.key || now - last.current.at > 1000) {
        past.current = [...past.current.slice(-HISTORY + 1), d];
        future.current = [];
      }
      last.current = { key, at: now };
      return fn(d);
    });
    bump((n) => n + 1);
  }, []);
  const undo = useCallback(() => setDraftRaw((d) => {
    const prev = past.current.pop();
    if (!d || !prev) return d;
    future.current.push(d);
    last.current = { key: "", at: 0 };
    return prev;
  }), []);
  const redo = useCallback(() => setDraftRaw((d) => {
    const next = future.current.pop();
    if (!d || !next) return d;
    past.current.push(d);
    return next;
  }), []);

  const change = useCallback((eid: string, patch: Partial<El>) => {
    edit((d) => ({ ...d, elements: d.elements.map((e) => (e.id === eid ? { ...e, ...patch } : e)) }), `${eid}:${Object.keys(patch).join()}`);
  }, [edit]);

  const remove = useCallback((ids: string[]) => {
    edit((d) => ({
      ...d,
      elements: d.elements
        .filter((e) => !ids.includes(e.id) && !ids.includes(e.from ?? "") && !ids.includes(e.to ?? ""))
        .map((e) => (e.rack && ids.includes(e.rack.id) ? { ...e, rack: undefined, x: 20, y: 20 } : e)),
    }));
    setSelected([]);
  }, [edit]);

  const select = useCallback((sid: string | null, add = false) => {
    setSelected((s) => (sid === null ? [] : add ? (s.includes(sid) ? s.filter((x) => x !== sid) : [...s, sid]) : [sid]));
  }, []);

  /** Pastes copies with new ids; cables and rack slots are kept when their counterpart is copied too. */
  const paste = useCallback(() => {
    if (!clipboard.length) return;
    edit((d) => {
      const ids = Object.fromEntries(clipboard.map((e) => [e.id, newId()]));
      const byId = Object.fromEntries(d.elements.map((e) => [e.id, e]));
      const copies = clipboard.flatMap((e): El[] => {
        const c: El = { ...e, id: ids[e.id] };
        if (e.type === "link") return ids[e.from ?? ""] && ids[e.to ?? ""] ? [{ ...c, from: ids[e.from!], to: ids[e.to!] }] : [];
        if (e.rack && ids[e.rack.id]) return [{ ...c, rack: { ...e.rack, id: ids[e.rack.id] } }];
        if (e.rack) { // rack not copied: the copy lands free next to the original
          const b = boxOf(e, byId) ?? { x: 20, y: 20 };
          return [{ ...c, rack: undefined, x: b.x + 40, y: b.y + 20 }];
        }
        return [{ ...c, x: (e.x ?? 0) + 20, y: (e.y ?? 0) + 20 }];
      });
      setSelected(copies.map((c) => c.id));
      return { ...d, elements: [...d.elements, ...copies] };
    });
  }, [edit]);

  useEffect(() => {
    if (!editing) return;
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev.target) || document.querySelector("dialog[open]")) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      if ((ev.key === "Delete" || ev.key === "Backspace") && selected.length) remove(selected);
      else if (mod && k === "z" && !ev.shiftKey) undo();
      else if (mod && (k === "y" || (k === "z" && ev.shiftKey))) redo();
      else if (mod && k === "c" && selected.length) {
        const sel = new Set(selected); // racks bring their devices along
        clipboard = content.elements.filter((e) => sel.has(e.id) || (e.rack && sel.has(e.rack.id)) || (e.type === "link" && sel.has(e.from ?? "") && sel.has(e.to ?? "")));
      } else if (mod && k === "v") paste();
      else if (mod && k === "a") setSelected(content.elements.map((e) => e.id));
      else return;
      ev.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selected, remove, undo, redo, paste, content]);

  function add(type: ElType) {
    const base: El = { id: newId(), type, x: 40, y: 40 };
    const extra: Partial<El> = {
      rack: { name: "Rack", w: 300, units: 12 },
      device: { name: tr("Gerät"), icon: "🖥️", w: 170, h: 56 },
      switch: { name: "Switch", icon: "🔀", w: 260, h: 60, ports: 8 },
      text: { text: tr("Text"), w: 200, h: 40 },
      link: { x: undefined, y: undefined, from: el && el.type !== "link" && el.type !== "text" ? el.id : "", to: "", label: "" },
    }[type] as Partial<El>;
    edit((d) => ({ ...d, elements: [...d.elements, { ...base, ...extra }] }));
    setSelected([base.id]);
  }

  /** Palette: a rack device goes to the dropped spot (snapping into a rack) or, on click, into the selected rack. */
  function addKind(kind: string, x?: number, y?: number) {
    const t = RACK_TYPES[kind];
    const e: El = { id: newId(), type: "device", kind, name: t.label, icon: t.icon || undefined, w: 220, h: Math.max(44, t.h * 30),
      ...(kind === "switch" || kind === "patch" ? { ports: 24 } : {}), ...(face === "back" ? { side: "back" as const } : {}) };
    const byId = Object.fromEntries(content.elements.map((x) => [x.id, x]));
    const hit = x !== undefined ? rackTarget(content.elements, byId, x, y!, heightOf(e), e) : null;
    const rack = hit?.rack ?? (x === undefined && el?.type === "rack" ? el : null);
    const u = hit ? (hit.free ? hit.u : null) : rack ? firstFree(content.elements, rack, t.h, e) : null;
    if (rack && u === null) return notify(tr("In „{v}“ sind an dieser Stelle keine {h} HE frei.", { v: rack.name || "Rack", h: t.h }));
    const placed: El = rack ? { ...e, rack: { id: rack.id, u: u!, h: t.h } } : { ...e, x: Math.max(0, (x ?? 60) - 20), y: Math.max(0, (y ?? 60) - 10) };
    edit((d) => ({ ...d, elements: [...d.elements, placed] }));
    setSelected([placed.id]);
  }

  async function save() {
    if (!node || !draft) return;
    const comment = await ask({ title: tr("Karte speichern"), label: tr("Kommentar zur Änderung (optional)"), ok: tr("Speichern") });
    if (comment === null) return;
    try {
      const n = await api<NodeDetail>(`/api/pages/${id}/content`, {
        method: "PUT", body: { content: draft, base_version: node.version, comment },
      });
      setNode(n);
      setDraft(null);
      onChanged();
    } catch (e) {
      notify(e instanceof ApiError && e.status === 409
        ? tr("Die Karte wurde inzwischen von jemand anderem gespeichert. Bitte Änderungen notieren und neu laden.")
        : e instanceof ApiError ? e.message : tr("Speichern fehlgeschlagen."));
    }
  }

  function findNext() {
    const ids = content.elements.filter((e) => matches.has(e.id)).map((e) => e.id);
    if (!ids.length) return;
    const next = ids[(ids.indexOf(primary ?? "") + 1) % ids.length];
    setSelected([next]);
    requestAnimationFrame(() => document.querySelector(".tab-pane:not([hidden]) .karte-sel")?.scrollIntoView({ block: "center", inline: "center" }));
  }
  // A search hit (?q=) selects the first matching element once the map is loaded.
  useEffect(() => { if (node && q && !primary) findNext(); }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!node) return <p className="muted">{tr("Karte wird geladen …")}</p>;
  const checked = content.elements.filter((e) => e.check && status[e.id] !== undefined);
  const modalEl = content.elements.find((e) => e.id === modal);
  const zoomTo = (z: number) => setZoom(Math.min(3, Math.max(0.5, z)));
  return (
    <div className="karte">
      <div className="page-head">
        <h1>{node.title}</h1>
        <div className="actions">
          {editing ? (
            <>
              <button className="primary" onClick={save}>{tr("Speichern")}</button>
              <button onClick={async () => { if (await confirmDialog({ title: tr("Änderungen verwerfen?"), ok: tr("Verwerfen"), danger: true })) { setDraft(null); setSelected([]); } }}>{tr("Abbrechen")}</button>
            </>
          ) : (
            <>
              <div role="tablist" className="actions">
                <button role="tab" aria-selected={tab === "map"} onClick={() => setTab("map")}>{tr("Karte")}</button>
                <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>{tr("Verlauf")}</button>
              </div>
              {node.permissions.write && (
                <button className="primary" onClick={() => {
                  setDraft(structuredClone(content));
                  setTab("map");
                  api<PageRef[]>("/api/pages").then(setPages).catch(() => setPages([]));
                }}>{tr("Bearbeiten")}</button>
              )}
            </>
          )}
        </div>
      </div>
      {content.testdaten && <p className="karte-banner" role="note"><strong>{tr("Testdaten")}</strong>{content.hinweis ? ` – ${content.hinweis}` : ""}</p>}
      {tab === "history" && !editing ? (
        <MapHistory node={node} onRestored={(n) => { setNode(n); setTab("map"); onChanged(); }} />
      ) : (
        <>
          {editing ? (
            <>
              <div className="karte-toolbar actions">
                {(["rack", "device", "switch", "text", "link"] as ElType[]).map((t) => (
                  <button key={t} onClick={() => add(t)}>+ {tr(TYPE_LABEL[t])}</button>
                ))}
                <span className="karte-sep" />
                <button className="icon-btn" title={tr("Rückgängig (Strg+Z)")} aria-label={tr("Rückgängig")} disabled={!past.current.length} onClick={undo}><Icon name="undo" /></button>
                <button className="icon-btn" title={tr("Wiederholen (Strg+Y)")} aria-label={tr("Wiederholen")} disabled={!future.current.length} onClick={redo}><Icon name="redo" /></button>
                <button className="icon-btn" title={tr("Löschen (Entf)")} aria-label={tr("Auswahl löschen")} disabled={!selected.length} onClick={() => remove(selected)}><Icon name="trash" /></button>
                <label className="karte-check">
                  <input type="checkbox" checked={!!draft.testdaten} onChange={(ev) => edit((d) => ({ ...d, testdaten: ev.target.checked }))} /> {tr("Testdaten")}</label>
                <span className="muted">{tr("Ziehen verschiebt und rastet im Rack ein, Umschalt-Klick wählt mehrere, Strg+C/V kopiert, Doppelklick zeigt alle Felder.")}</span>
              </div>
              <div className="karte-palette" aria-label={tr("Rack-Geräte: ins Rack ziehen oder anklicken (landet im gewählten Rack)")}>
                {Object.entries(RACK_TYPES).map(([k, t]) => (
                  <button key={k} draggable title={tr("{label} ({h} HE)", { label: tr(t.label), h: t.h })} onClick={() => addKind(k)}
                    onDragStart={(ev) => { ev.dataTransfer.setData("text/x-rack-kind", k); ev.dataTransfer.effectAllowed = "copy"; }}>
                    {t.icon && <span aria-hidden="true">{t.icon}</span>}{tr(t.label)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="muted">
              {checked.filter((e) => status[e.id]).length} {tr("von")}{" "}{checked.length} {tr("geprüften Elementen erreichbar · aktualisiert sich jede Minute")}</p>
          )}
          <div className="karte-view actions">
            <input type="search" className="karte-search" placeholder={tr("In der Karte suchen (Name, IP, Host, MAC) …")} aria-label={tr("In der Karte suchen")}
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); findNext(); } }} />
            {q && <span className="muted" role="status">{matches.size} {tr("Treffer")}{matches.size ? tr(" · Enter springt weiter") : ""}</span>}
            <span className="spacer" />
            {content.elements.some((e) => e.type === "rack") && (
              <div role="radiogroup" aria-label={tr("Rack-Ansicht")} className="actions">
                {(["front", "back"] as Face[]).map((f) => (
                  <button key={f} role="radio" aria-checked={face === f} className={face === f ? "primary" : undefined}
                    onClick={() => setFace(f)}>{f === "front" ? tr("Vorderseite") : tr("Rückseite")}</button>
                ))}
              </div>
            )}
            <label className="karte-check">{tr("Kabelfarbe")}<select value={cableMode} onChange={(e) => setCableMode(e.target.value as CableMode)}>
                <option value="medium">{tr("nach Medium")}</option>
                <option value="vlan">{tr("nach VLAN")}</option>
                <option value="none">{tr("einheitlich")}</option>
              </select>
            </label>
            {!editing && content.elements.length > 0 && (
              <>
                <button onClick={() => svgRef.current && exportSvg(svgRef.current, node.title)} title={tr("Karte als SVG herunterladen")}>{tr("SVG")}</button>
                <button onClick={() => svgRef.current && exportPng(svgRef.current, node.title).catch(() => notify(tr("PNG-Export fehlgeschlagen.")))}
                  title={tr("Karte als PNG herunterladen (zum Ausdrucken)")}>{tr("PNG")}</button>
              </>
            )}
            <button className="icon-btn" aria-label={tr("Verkleinern")} title={tr("Verkleinern")} onClick={() => zoomTo(ZOOMS.filter((z) => z < zoom).pop() ?? 0.5)}>−</button>
            <button onClick={() => setZoom(1)} title={tr("Alles zeigen (an die Breite anpassen)")}>{Math.round(zoom * 100)} %</button>
            <button className="icon-btn" aria-label={tr("Vergrößern")} title={tr("Vergrößern (Strg+Mausrad)")} onClick={() => zoomTo(ZOOMS.find((z) => z > zoom) ?? 3)}>+</button>
          </div>
          <CableLegend content={content} mode={cableMode} />
          {!editing && el?.diagram && showDiagram && <DrawioView key={el.diagram} fileId={el.diagram} />}
          <div className={editing || (el && el.type !== "link") ? "karte-editor" : ""}>
            <div className="karte-scroll" ref={scroller}>
              {content.elements.length ? (
                <Canvas content={content} status={status} editing={editing} selected={selected} onSelect={select}
                  onChange={change} onOpen={setModal} onDropKind={addKind} zoom={zoom} matches={matches} cableMode={cableMode} svgRef={svgRef} face={face} />
              ) : (
                <p className="muted">{tr("Die Karte ist leer.")}{" "}{node.permissions.write && tr("Mit „Bearbeiten“ Elemente hinzufügen.")}</p>
              )}
            </div>
            {editing ? (el ? (
              <Props el={el} content={content} pages={pages} onChange={(p) => change(el.id, p)} onDelete={() => remove(selected)} />
            ) : (
              <div className="karte-props muted">{tr("Element anklicken, um es zu bearbeiten.")}</div>
            )) : el && el.type !== "link" && (
              <DetailPanel el={el} content={content} status={status} onOpen={() => setModal(el.id)}
                diagramOpen={showDiagram} onDiagram={() => setShowDiagram(!showDiagram)} />
            )}
          </div>
        </>
      )}
      {modalEl && (
        <DetailModal title={modalEl.name || tr(TYPE_LABEL[modalEl.type])} onClose={() => setModal(null)}>
          {editing ? <Props el={modalEl} content={content} pages={pages} onChange={(p) => change(modalEl.id, p)}
            onDelete={() => { setModal(null); remove([modalEl.id]); }} />
            : <Facts el={modalEl} content={content} status={status} />}
        </DetailModal>
      )}
    </div>
  );
}

/** Legend for the cable colours actually used in this map. */
function CableLegend({ content, mode }: { content: MapContent; mode: CableMode }) {
  const cables = content.elements.filter((e) => e.type === "link" && !e.color);
  const items = mode === "medium"
    ? [...new Set(cables.map((c) => c.medium).filter(Boolean) as string[])].map((m) => [tr(MEDIA[m]?.label ?? m), MEDIA[m]?.color] as const)
    : mode === "vlan"
      ? [...new Set(cables.map((c) => c.vlan).filter((v) => v !== undefined) as number[])].sort((a, b) => a - b).map((v) => [`VLAN ${v}`, vlanColor(v)] as const)
      : [];
  if (!items.length) return null;
  return (
    <ul className="karte-legend" aria-label={tr("Legende Kabelfarben")}>
      {items.map(([label, color]) => <li key={label}><span style={{ background: color }} aria-hidden="true" />{label}</li>)}
    </ul>
  );
}
