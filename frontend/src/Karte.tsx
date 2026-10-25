import { PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, NodeDetail } from "./api";
import { DrawioView } from "./Drawio";

type ElType = "rack" | "device" | "switch" | "text" | "link";

interface El {
  id: string;
  type: ElType;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  name?: string;
  icon?: string;
  ip?: string;
  check?: string;
  color?: string;
  units?: number;
  ports?: number;
  rack?: { id: string; u: number; h: number };
  text?: string;
  from?: string;
  to?: string;
  from_port?: number;
  to_port?: number;
  label?: string;
  page?: string; // wiki page (manual or network page)
  diagram?: string; // .drawio file node
}

interface PageRef {
  id: string;
  title: string;
  path: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// SPA navigation from inside a view: main.tsx follows popstate.
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

interface MapContent {
  testdaten?: boolean;
  hinweis?: string;
  elements: El[];
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const GRID = 10;
const UH = 30; // px per rack unit
const RACK_HEAD = 26;
const LABEL = { true: "erreichbar", false: "nicht erreichbar", undefined: "nicht geprüft" } as const;
const TYPE_LABEL: Record<ElType, string> = { rack: "Rack", device: "Gerät", switch: "Switch", text: "Text", link: "Kabel" };

const snap = (v: number) => Math.round(v / GRID) * GRID;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8);

function boxOf(e: El, byId: Record<string, El>): Box | null {
  if (e.type === "link") return null;
  if (e.type === "rack") return { x: e.x ?? 0, y: e.y ?? 0, w: e.w ?? 300, h: RACK_HEAD + (e.units ?? 12) * UH };
  const rack = e.rack && byId[e.rack.id];
  if (rack && rack.type === "rack") {
    const r = boxOf(rack, byId)!;
    const units = rack.units ?? 12;
    return { x: r.x + 28, y: r.y + RACK_HEAD + (units - e.rack!.u - e.rack!.h + 1) * UH + 2, w: r.w - 36, h: e.rack!.h * UH - 4 };
  }
  return { x: e.x ?? 0, y: e.y ?? 0, w: e.w ?? 160, h: e.h ?? 50 };
}

function portPoint(b: Box, ports: number, port: number) {
  const cols = ports > 12 ? Math.ceil(ports / 2) : ports;
  const k = Math.min(Math.max(port, 1), ports) - 1;
  const row = Math.floor(k / cols);
  const col = k % cols;
  return { x: b.x + 10 + (col * (b.w - 20)) / Math.max(cols - 1, 1), y: b.y + b.h - (ports > 12 ? 18 : 10) + row * 9 };
}

function anchor(e: El | undefined, port: number | undefined, byId: Record<string, El>) {
  if (!e) return null;
  const b = boxOf(e, byId);
  if (!b) return null;
  if (e.type === "switch" && port && e.ports) return portPoint(b, e.ports, port);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function Canvas({ content, status, editing, selected, onSelect, onChange }: {
  content: MapContent;
  status: Record<string, boolean>;
  editing: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<El>) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "size"; dx: number; dy: number; start: Box } | null>(null);
  const byId = useMemo(() => Object.fromEntries(content.elements.map((e) => [e.id, e])), [content]);
  const boxes = content.elements.map((e) => boxOf(e, byId)).filter(Boolean) as Box[];
  const width = Math.max(900, ...boxes.map((b) => b.x + b.w + 120));
  const height = Math.max(500, ...boxes.map((b) => b.y + b.h + 60));

  function point(ev: ReactPointerEvent) {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * width) / r.width, y: ((ev.clientY - r.top) * height) / r.height };
  }

  function startDrag(ev: ReactPointerEvent, e: El, mode: "move" | "size") {
    onSelect(e.id);
    if (!editing || (e.rack && byId[e.rack.id])) return; // rack-mounted devices are placed via U in the panel
    ev.stopPropagation();
    const p = point(ev);
    const b = boxOf(e, byId)!;
    drag.current = { id: e.id, mode, dx: p.x - b.x, dy: p.y - b.y, start: b };
    svg.current!.setPointerCapture(ev.pointerId);
  }

  function moveDrag(ev: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = point(ev);
    if (d.mode === "move") onChange(d.id, { x: Math.max(0, snap(p.x - d.dx)), y: Math.max(0, snap(p.y - d.dy)) });
    else onChange(d.id, { w: Math.max(80, snap(p.x - d.start.x)), h: Math.max(30, snap(p.y - d.start.y)) });
  }

  const links = content.elements.filter((e) => e.type === "link");
  const shapes = [...content.elements.filter((e) => e.type === "rack"), ...content.elements.filter((e) => e.type !== "rack" && e.type !== "link")];

  return (
    <svg ref={svg} className={`karte-canvas${editing ? " editing" : ""}`} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={`Karte mit ${shapes.length} Elementen und ${links.length} Kabeln`}
      onPointerMove={moveDrag} onPointerUp={() => { drag.current = null; }}
      onPointerDown={() => editing && onSelect(null)}>
      {editing && (
        <defs>
          <pattern id="karte-grid" width={GRID * 2} height={GRID * 2} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID * 2} 0 L 0 0 0 ${GRID * 2}`} className="karte-gridline" />
          </pattern>
        </defs>
      )}
      {editing && <rect width={width} height={height} fill="url(#karte-grid)" />}
      {shapes.map((e) => {
        const b = boxOf(e, byId)!;
        const sel = e.id === selected;
        const style = e.color ? { stroke: e.color } : undefined;
        if (e.type === "rack") {
          return (
            <g key={e.id} onPointerDown={(ev) => startDrag(ev, e, "move")} className={sel ? "karte-sel" : ""}>
              <title>{e.name}</title>
              <rect className="karte-rack" x={b.x} y={b.y} width={b.w} height={b.h} rx={6} style={style} />
              <text className="karte-name" x={b.x + 10} y={b.y + 18}>{e.name}</text>
              {Array.from({ length: e.units ?? 12 }, (_, i) => (
                <g key={i}>
                  <rect className="karte-slot" x={b.x + 24} y={b.y + RACK_HEAD + i * UH} width={b.w - 32} height={UH} />
                  <text className="karte-u" x={b.x + 18} y={b.y + RACK_HEAD + i * UH + UH / 2 + 4} textAnchor="end">{(e.units ?? 12) - i}</text>
                </g>
              ))}
              {editing && sel && <ResizeHandle b={b} onDown={(ev) => startDrag(ev, e, "size")} />}
            </g>
          );
        }
        if (e.type === "text") {
          return (
            <g key={e.id} onPointerDown={(ev) => startDrag(ev, e, "move")} className={sel ? "karte-sel" : ""}>
              {editing && <rect className="karte-textbox" x={b.x} y={b.y} width={b.w} height={b.h} />}
              <foreignObject x={b.x} y={b.y} width={b.w} height={b.h}>
                <div className="karte-text" style={e.color ? { color: e.color } : undefined}>{e.text}</div>
              </foreignObject>
              {editing && sel && <ResizeHandle b={b} onDown={(ev) => startDrag(ev, e, "size")} />}
            </g>
          );
        }
        const online = e.check ? status[e.id] : undefined;
        return (
          <g key={e.id} onPointerDown={(ev) => startDrag(ev, e, "move")} className={sel ? "karte-sel" : ""}>
            <title>{`${e.name ?? ""}${e.ip ? ` (${e.ip})` : ""}: ${LABEL[String(online) as keyof typeof LABEL]}`}</title>
            <rect className="karte-dev" x={b.x} y={b.y} width={b.w} height={b.h} rx={4}
              style={e.color ? { stroke: e.color, fill: e.color, fillOpacity: 0.15 } : undefined} />
            <text className="karte-name" x={b.x + 10} y={b.y + Math.min(b.h / 2 + 5, 20)}>{`${e.icon ? `${e.icon} ` : ""}${e.name ?? ""}${e.page ? " 📖" : ""}`}</text>
            {e.ip && b.h >= 44 && <text className="karte-u" x={b.x + 10} y={b.y + 36}>{e.ip}</text>}
            {e.check && <circle className={`karte-dot ${online === undefined ? "unknown" : online ? "up" : "down"}`} cx={b.x + b.w - 12} cy={b.y + 12} r={6} />}
            {e.type === "switch" && Array.from({ length: e.ports ?? 0 }, (_, i) => {
              const p = portPoint(b, e.ports!, i + 1);
              return <rect key={i} className="karte-port-box" x={p.x - 3} y={p.y - 3} width={6} height={6}><title>{`Port ${i + 1}`}</title></rect>;
            })}
            {editing && sel && !(e.rack && byId[e.rack.id]) && <ResizeHandle b={b} onDown={(ev) => startDrag(ev, e, "size")} />}
          </g>
        );
      })}
      {links.map((e, i) => {
        const a = anchor(byId[e.from ?? ""], e.from_port, byId);
        const z = anchor(byId[e.to ?? ""], e.to_port, byId);
        if (!a || !z) return null;
        const fromEl = byId[e.from!], toEl = byId[e.to!];
        const sameRack = !e.from_port && !e.to_port && fromEl.rack && fromEl.rack.id === toEl.rack?.id && byId[fromEl.rack.id];
        let d = `M ${a.x} ${a.y} L ${z.x} ${z.y}`;
        let mid = { x: (a.x + z.x) / 2, y: (a.y + z.y) / 2 };
        if (sameRack) {
          const r = boxOf(byId[fromEl.rack!.id], byId)!;
          const right = r.x + r.w - 8, bend = r.x + r.w + 20 + (i % 4) * 18;
          d = `M ${right} ${a.y} C ${bend} ${a.y}, ${bend} ${z.y}, ${right} ${z.y}`;
          mid = { x: bend + 4, y: (a.y + z.y) / 2 };
        }
        return (
          <g key={e.id} onPointerDown={(ev) => { ev.stopPropagation(); onSelect(e.id); }}>
            <title>{`Kabel ${fromEl.name ?? ""} → ${toEl.name ?? ""}${e.label ? `: ${e.label}` : ""}`}</title>
            <path className="karte-hit" d={d} />
            <path className={`karte-cable${e.id === selected ? " selected" : ""}`} d={d} style={e.color ? { stroke: e.color } : undefined} />
            {e.label && <text className="karte-port" x={mid.x + 4} y={mid.y - 4}>{e.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function ResizeHandle({ b, onDown }: { b: Box; onDown: (ev: ReactPointerEvent) => void }) {
  return <rect className="karte-handle" x={b.x + b.w - 6} y={b.y + b.h - 6} width={12} height={12} onPointerDown={onDown}><title>Größe ändern</title></rect>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="karte-field">{label}{children}</label>;
}

function Props({ el, content, pages, onChange, onDelete }: {
  el: El;
  content: MapContent;
  pages: PageRef[];
  onChange: (patch: Partial<El>) => void;
  onDelete: () => void;
}) {
  const others = content.elements.filter((e) => e.type !== "link" && e.type !== "text" && e.id !== el.id);
  const racks = content.elements.filter((e) => e.type === "rack");
  const text = (k: keyof El, label: string, placeholder = "") => (
    <Field label={label}>
      <input value={(el[k] as string) ?? ""} placeholder={placeholder} onChange={(ev) => onChange({ [k]: ev.target.value })} />
    </Field>
  );
  const num = (k: keyof El, label: string, min = 1, max = 99) => (
    <Field label={label}>
      <input type="number" min={min} max={max} value={(el[k] as number) ?? ""}
        onChange={(ev) => onChange({ [k]: ev.target.value === "" ? undefined : Math.min(max, Math.max(min, Number(ev.target.value))) })} />
    </Field>
  );
  const endpoint = (side: "from" | "to") => {
    const target = content.elements.find((e) => e.id === el[side]);
    return (
      <>
        <Field label={side === "from" ? "Von" : "Nach"}>
          <select value={el[side] ?? ""} onChange={(ev) => onChange({ [side]: ev.target.value, [`${side}_port`]: undefined })}>
            <option value="">– wählen –</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name || TYPE_LABEL[o.type]}</option>)}
          </select>
        </Field>
        {target?.type === "switch" && num(`${side}_port` as keyof El, "Port", 1, target.ports ?? 1)}
      </>
    );
  };
  return (
    <div className="karte-props">
      <h3>{TYPE_LABEL[el.type]}</h3>
      {el.type === "link" ? (
        <>
          {endpoint("from")}
          {endpoint("to")}
          {text("label", "Beschriftung", "z. B. Port 24 ↔ LAN 1")}
        </>
      ) : el.type === "text" ? (
        <Field label="Text">
          <textarea rows={4} value={el.text ?? ""} onChange={(ev) => onChange({ text: ev.target.value })} />
        </Field>
      ) : (
        <>
          {text("name", "Name")}
          {el.type !== "rack" && text("icon", "Symbol (Emoji)", "🖥️")}
          {el.type === "rack" && num("units", "Höheneinheiten", 1, 52)}
          <Field label="Handbuch/Seite">
            <select value={el.page ?? ""} onChange={(ev) => onChange({ page: ev.target.value || undefined })}>
              <option value="">– keine –</option>
              {el.page && !pages.some((p) => p.id === el.page) && <option value={el.page}>(Seite nicht gefunden)</option>}
              {pages.map((p) => <option key={p.id} value={p.id}>{p.path ? `${p.path} / ` : ""}{p.title}</option>)}
            </select>
          </Field>
          <Field label="Schaubild (draw.io-Datei, Link oder ID)">
            <input value={el.diagram ?? ""} placeholder="https://…/n/…"
              onChange={(ev) => onChange({ diagram: ev.target.value.match(UUID_RE)?.[0] ?? (ev.target.value || undefined) })} />
          </Field>
          {el.type === "switch" && num("ports", "Ports", 1, 52)}
          {el.type !== "rack" && (
            <>
              {text("ip", "IP/Host (Anzeige)", "192.0.2.10")}
              {text("check", "Live-Check", "https://… oder tcp://host:port")}
              <Field label="Im Rack">
                <select value={el.rack?.id ?? ""} onChange={(ev) => onChange({
                  rack: ev.target.value ? { id: ev.target.value, u: el.rack?.u ?? 1, h: el.rack?.h ?? 1 } : undefined,
                })}>
                  <option value="">– frei platziert –</option>
                  {racks.map((r) => <option key={r.id} value={r.id}>{r.name || "Rack"}</option>)}
                </select>
              </Field>
              {el.rack && (
                <div className="karte-row">
                  <Field label="Unterste HE">
                    <input type="number" min={1} max={52} value={el.rack.u}
                      onChange={(ev) => onChange({ rack: { ...el.rack!, u: Math.max(1, Number(ev.target.value) || 1) } })} />
                  </Field>
                  <Field label="Höhe (HE)">
                    <input type="number" min={1} max={52} value={el.rack.h}
                      onChange={(ev) => onChange({ rack: { ...el.rack!, h: Math.max(1, Number(ev.target.value) || 1) } })} />
                  </Field>
                </div>
              )}
            </>
          )}
        </>
      )}
      <Field label="Farbe">
        <div className="karte-row">
          <input type="color" value={el.color || "#2563eb"} onChange={(ev) => onChange({ color: ev.target.value })} />
          {el.color && <button type="button" onClick={() => onChange({ color: "" })}>Standard</button>}
        </div>
      </Field>
      <button type="button" className="danger" onClick={onDelete}>Element entfernen</button>
    </div>
  );
}

interface Revision {
  id: number;
  user: string | null;
  comment: string;
  created_at: string;
}

function MapHistory({ node, onRestored }: { node: NodeDetail; onRestored: (n: NodeDetail) => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  useEffect(() => {
    api<Revision[]>(`/api/nodes/${node.id}/history`).then(setRevs).catch(() => setRevs([]));
  }, [node.id, node.version]);
  if (!revs) return <p className="muted">Verlauf wird geladen …</p>;
  return (
    <ul className="karte-history">
      {revs.map((r, i) => (
        <li key={r.id}>
          <span>{new Date(r.created_at).toLocaleString("de-DE")} · {r.user ?? "System"}{r.comment && ` · ${r.comment}`}</span>
          {i === 0 ? <span className="muted">aktuell</span> : (
            <button onClick={async () => {
              if (confirm("Diese Version wiederherstellen? Die aktuelle bleibt im Verlauf."))
                onRestored(await api<NodeDetail>(`/api/nodes/${node.id}/history/${r.id}/restore`, { method: "POST" }));
            }}>Wiederherstellen</button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MapView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [pages, setPages] = useState<PageRef[]>([]);
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [draft, setDraft] = useState<MapContent | null>(null);
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("el"));
  const [tab, setTab] = useState<"map" | "history">("map");
  const [showDiagram, setShowDiagram] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => api<NodeDetail>(`/api/nodes/${id}`).then(setNode).catch(() => setError("Karte konnte nicht geladen werden.")), [id]);
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
  const el = content.elements.find((e) => e.id === selected) ?? null;

  const change = useCallback((eid: string, patch: Partial<El>) => {
    setDraft((d) => d && { ...d, elements: d.elements.map((e) => (e.id === eid ? { ...e, ...patch } : e)) });
  }, []);

  const remove = useCallback((eid: string) => {
    setDraft((d) => d && {
      ...d,
      elements: d.elements
        .filter((e) => e.id !== eid && e.from !== eid && e.to !== eid)
        .map((e) => (e.rack?.id === eid ? { ...e, rack: undefined, x: 20, y: 20 } : e)),
    });
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!editing) return;
    const onKey = (ev: KeyboardEvent) => {
      const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLSelectElement;
      if ((ev.key === "Delete" || ev.key === "Backspace") && selected && !typing) remove(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, selected, remove]);

  function add(type: ElType) {
    const base: El = { id: newId(), type, x: 40, y: 40 };
    const extra: Partial<El> = {
      rack: { name: "Rack", w: 300, units: 12 },
      device: { name: "Gerät", icon: "🖥️", w: 170, h: 56 },
      switch: { name: "Switch", icon: "🔀", w: 260, h: 60, ports: 8 },
      text: { text: "Text", w: 200, h: 40 },
      link: { x: undefined, y: undefined, from: el && el.type !== "link" && el.type !== "text" ? el.id : "", to: "", label: "" },
    }[type] as Partial<El>;
    setDraft((d) => d && { ...d, elements: [...d.elements, { ...base, ...extra }] });
    setSelected(base.id);
  }

  async function save() {
    if (!node || !draft) return;
    const comment = prompt("Kommentar zur Änderung (optional):") ?? "";
    try {
      const n = await api<NodeDetail>(`/api/pages/${id}/content`, {
        method: "PUT", body: { content: draft, base_version: node.version, comment },
      });
      setNode(n);
      setDraft(null);
      onChanged();
    } catch (e) {
      alert(e instanceof ApiError && e.status === 409
        ? "Die Karte wurde inzwischen von jemand anderem gespeichert. Bitte Änderungen notieren und neu laden."
        : e instanceof ApiError ? e.message : "Speichern fehlgeschlagen.");
    }
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!node) return <p className="muted">Karte wird geladen …</p>;
  const checked = content.elements.filter((e) => e.check && status[e.id] !== undefined);
  return (
    <div className="karte">
      <div className="page-head">
        <h1>{node.title}</h1>
        <div className="actions">
          {editing ? (
            <>
              <button className="primary" onClick={save}>Speichern</button>
              <button onClick={() => { if (confirm("Änderungen verwerfen?")) { setDraft(null); setSelected(null); } }}>Abbrechen</button>
            </>
          ) : (
            <>
              <div role="tablist" className="actions">
                <button role="tab" aria-selected={tab === "map"} onClick={() => setTab("map")}>Karte</button>
                <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>Verlauf</button>
              </div>
              {node.permissions.write && (
                <button className="primary" onClick={() => {
                  setDraft(structuredClone(content));
                  setTab("map");
                  api<PageRef[]>("/api/pages").then(setPages).catch(() => setPages([]));
                }}>Bearbeiten</button>
              )}
            </>
          )}
        </div>
      </div>
      {content.testdaten && <p className="karte-banner" role="note"><strong>Testdaten</strong>{content.hinweis ? ` – ${content.hinweis}` : ""}</p>}
      {tab === "history" && !editing ? (
        <MapHistory node={node} onRestored={(n) => { setNode(n); setTab("map"); onChanged(); }} />
      ) : (
        <>
          {editing ? (
            <div className="karte-toolbar actions">
              {(["rack", "device", "switch", "text", "link"] as ElType[]).map((t) => (
                <button key={t} onClick={() => add(t)}>+ {TYPE_LABEL[t]}</button>
              ))}
              <label className="karte-check">
                <input type="checkbox" checked={!!draft.testdaten} onChange={(ev) => setDraft({ ...draft, testdaten: ev.target.checked })} /> Testdaten
              </label>
              <span className="muted">Ziehen verschiebt, das Eck-Quadrat ändert die Größe, Entf löscht.</span>
            </div>
          ) : (
            <>
              <p className="muted">
                {checked.filter((e) => status[e.id]).length} von {checked.length} geprüften Elementen erreichbar · aktualisiert sich jede Minute
              </p>
              {el && el.type !== "link" && (
                <div className="karte-info actions" role="status">
                  <strong>{el.name || TYPE_LABEL[el.type]}</strong>
                  {el.ip && <span className="muted">{el.ip}</span>}
                  {el.check && <span className="muted">{LABEL[String(status[el.id]) as keyof typeof LABEL]}</span>}
                  {el.page && <button onClick={() => navigate(`/n/${el.page}`)}>📖 Seite öffnen</button>}
                  {el.diagram && <button aria-expanded={showDiagram} onClick={() => setShowDiagram(!showDiagram)}>📐 Schaubild {showDiagram ? "schließen" : "öffnen"}</button>}
                  {!el.page && !el.diagram && <span className="muted">Keine Seite verknüpft.</span>}
                </div>
              )}
              {el?.diagram && showDiagram && <DrawioView key={el.diagram} fileId={el.diagram} />}
            </>
          )}
          <div className={editing ? "karte-editor" : ""}>
            <div className="karte-scroll">
              {content.elements.length ? (
                <Canvas content={content} status={status} editing={editing} selected={selected} onSelect={setSelected}
                  onChange={change} />
              ) : (
                <p className="muted">Die Karte ist leer. {node.permissions.write && "Mit „Bearbeiten“ Elemente hinzufügen."}</p>
              )}
            </div>
            {editing && (el ? (
              <Props el={el} content={content} pages={pages} onChange={(p) => change(el.id, p)} onDelete={() => remove(el.id)} />
            ) : (
              <div className="karte-props muted">Element anklicken, um es zu bearbeiten.</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Backlinks on a wiki page: map elements and network-plan shortcuts that point at it. */
export function MapLinks({ id }: { id: string }) {
  const [maps, setMaps] = useState<{ id: string; kind: string; title: string; elements: { id: string; name: string }[] }[]>([]);
  useEffect(() => {
    api<typeof maps>(`/api/nodes/${id}/maps`).then(setMaps).catch(() => setMaps([]));
  }, [id]);
  if (!maps.length) return null;
  return (
    <div className="karte-links">
      <h3>Im Reiter Netzwerk</h3>
      <ul>
        {maps.flatMap((m) => (m.kind === "link" ? [{ id: "", name: "" }] : m.elements).map((e) => {
          const href = `/netzwerk/${m.id}${e.id ? `?el=${encodeURIComponent(e.id)}` : ""}`;
          return (
            <li key={`${m.id}-${e.id}`}>
              <a href={href} onClick={(ev) => { ev.preventDefault(); navigate(href); }}>
                {m.kind === "link" ? `📐 Netzplan „${m.title}“ öffnen` : `🗺️ ${m.title}: ${e.name}`}
              </a>
            </li>
          );
        }))}
      </ul>
    </div>
  );
}

/** Network tab content: a map, or a shortcut that shows its .drawio plan from the wiki (single source). */
export function NetView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<NodeDetail>(`/api/nodes/${id}`).then(setNode).catch(() => setError("Eintrag konnte nicht geladen werden."));
  }, [id]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!node) return <p className="muted">Wird geladen …</p>;
  if (node.kind === "map") return <MapView id={id} onChanged={onChanged} />;
  if (node.kind === "link") {
    return (
      <div className="karte">
        <h1>📐 {node.title}</h1>
        {node.target ? <DrawioView fileId={node.target} /> : <p className="error" role="alert">Der verknüpfte Netzplan wurde im Wiki gelöscht.</p>}
      </div>
    );
  }
  return (
    <>
      <h1>{node.title}</h1>
      <p className="muted">Ordner: links einen Eintrag wählen. Rechtsklick legt Karten, Ordner oder Netzplan-Verknüpfungen an.</p>
    </>
  );
}
