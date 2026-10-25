import { PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import { El, MapContent, Box, GRID, UH, RACK_HEAD, LABEL, snap, boxOf, portPoint, anchor, hasPorts, kindOf, CableMode, cableColor, MEDIA } from "./model";
import { RACK_TYPES, RackFront, SlotHint, rackTarget, Face, onFace } from "./rack";

type Target = ReturnType<typeof rackTarget>;
export const heightOf = (e: El) => e.rack?.h ?? RACK_TYPES[kindOf(e) ?? ""]?.h ?? 1;

export function Canvas({ content, status, editing, selected, onSelect, onChange, onOpen, onDropKind, zoom = 1, matches, cableMode = "none", svgRef, face = "front" }: {
  content: MapContent;
  status: Record<string, boolean>;
  editing: boolean;
  selected: string[];
  onSelect: (id: string | null, add?: boolean) => void;
  onChange: (id: string, patch: Partial<El>) => void;
  onOpen?: (id: string) => void; // double click: detail modal
  onDropKind?: (kind: string, x: number, y: number) => void; // palette item dropped on the canvas
  zoom?: number;
  matches?: Set<string>; // search hits in the map
  cableMode?: CableMode;
  face?: Face; // rack side shown; devices on the other side are drawn faint
  svgRef?: React.MutableRefObject<SVGSVGElement | null>; // for the image export
}) {
  const own = useRef<SVGSVGElement>(null);
  const svg = svgRef ?? own;
  const drag = useRef<{ id: string; mode: "move" | "size"; dx: number; dy: number; start: Box } | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  // Devices follow the pointer as a ghost and are committed on release, so they can snap into rack units.
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number; target: Target } | null>(null);
  const byId = useMemo(() => Object.fromEntries(content.elements.map((e) => [e.id, e])), [content]);
  const boxes = content.elements.map((e) => boxOf(e, byId)).filter(Boolean) as Box[];
  const width = Math.max(900, ...boxes.map((b) => b.x + b.w + 120));
  const height = Math.max(500, ...boxes.map((b) => b.y + b.h + 60));

  function point(ev: { clientX: number; clientY: number }) {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) * width) / r.width, y: ((ev.clientY - r.top) * height) / r.height };
  }

  function startDrag(ev: ReactPointerEvent, e: El, mode: "move" | "size") {
    onSelect(e.id, ev.shiftKey);
    ev.stopPropagation(); // the background would clear the selection (edit) or start panning and capture the pointer (view)
    if (!editing || ev.shiftKey || ev.button !== 0) return;
    const p = point(ev);
    const b = boxOf(e, byId)!;
    drag.current = { id: e.id, mode, dx: p.x - b.x, dy: p.y - b.y, start: b };
    svg.current!.setPointerCapture(ev.pointerId);
  }

  function moveDrag(ev: ReactPointerEvent) {
    if (pan.current) {
      const box = svg.current!.parentElement!;
      box.scrollLeft = pan.current.left - (ev.clientX - pan.current.x);
      box.scrollTop = pan.current.top - (ev.clientY - pan.current.y);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const p = point(ev);
    const e = byId[d.id];
    if (d.mode === "move" && e.type !== "rack" && e.type !== "text") {
      const x = snap(p.x - d.dx), y = snap(p.y - d.dy);
      setGhost({ id: d.id, x, y, target: rackTarget(content.elements, byId, p.x, p.y - d.dy, heightOf(e), e) });
    } else if (d.mode === "move") onChange(d.id, { x: Math.max(0, snap(p.x - d.dx)), y: Math.max(0, snap(p.y - d.dy)) });
    else onChange(d.id, { w: Math.max(80, snap(p.x - d.start.x)), h: Math.max(30, snap(p.y - d.start.y)) });
  }

  function endDrag() {
    pan.current = null;
    drag.current = null;
    if (!ghost) return;
    const t = ghost.target;
    if (t && t.free) onChange(ghost.id, { rack: { id: t.rack.id, u: t.u, h: t.h } });
    else if (!t) onChange(ghost.id, { rack: undefined, x: Math.max(0, ghost.x), y: Math.max(0, ghost.y) }); // dragged out: free again
    setGhost(null); // taken units: the device snaps back
  }

  const links = content.elements.filter((e) => e.type === "link");
  const shapes = [...content.elements.filter((e) => e.type === "rack"), ...content.elements.filter((e) => e.type !== "rack" && e.type !== "link")];
  const cls = (e: El) => [selected.includes(e.id) && "karte-sel", matches?.has(e.id) && "karte-match"].filter(Boolean).join(" ");

  return (
    <svg ref={svg} className={`karte-canvas${editing ? " editing" : ""}`} viewBox={`0 0 ${width} ${height}`}
      style={{ width: `${zoom * 100}%`, minWidth: 700 * zoom }}
      role="img" aria-label={`Karte mit ${shapes.length} Elementen und ${links.length} Kabeln`}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
      onPointerDown={(ev) => {
        if (editing) { onSelect(null); return; }
        const box = svg.current!.parentElement!; // view mode: dragging the background pans
        pan.current = { x: ev.clientX, y: ev.clientY, left: box.scrollLeft, top: box.scrollTop };
        svg.current!.setPointerCapture(ev.pointerId);
      }}
      onDragOver={(ev) => { if (editing && ev.dataTransfer.types.includes("text/x-rack-kind")) ev.preventDefault(); }}
      onDrop={(ev) => {
        const kind = ev.dataTransfer.getData("text/x-rack-kind");
        if (!kind || !onDropKind) return;
        ev.preventDefault();
        const p = point(ev);
        onDropKind(kind, p.x, p.y);
      }}>
      {editing && (
        <defs>
          <pattern id="karte-grid" width={GRID * 2} height={GRID * 2} patternUnits="userSpaceOnUse">
            <path d={`M ${GRID * 2} 0 L 0 0 0 ${GRID * 2}`} className="karte-gridline" />
          </pattern>
        </defs>
      )}
      {editing && <rect width={width} height={height} fill="url(#karte-grid)" />}
      {shapes.map((e) => {
        const computed = boxOf(e, byId)!;
        const b = ghost?.id === e.id ? { ...computed, x: ghost.x, y: ghost.y } : computed;
        const sel = selected.includes(e.id);
        const style = e.color ? { stroke: e.color } : undefined;
        const events = { onPointerDown: (ev: ReactPointerEvent) => startDrag(ev, e, "move"), onDoubleClick: () => onOpen?.(e.id) };
        if (e.type === "rack") {
          return (
            <g key={e.id} {...events} className={cls(e)}>
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
            <g key={e.id} {...events} className={cls(e)}>
              {editing && <rect className="karte-textbox" x={b.x} y={b.y} width={b.w} height={b.h} />}
              <foreignObject x={b.x} y={b.y} width={b.w} height={b.h}>
                <div className="karte-text" style={e.color ? { color: e.color } : undefined}>{e.text}</div>
              </foreignObject>
              {editing && sel && <ResizeHandle b={b} onDown={(ev) => startDrag(ev, e, "size")} />}
            </g>
          );
        }
        const online = e.check ? status[e.id] : undefined;
        const host = e.ip || e.hostname;
        return (
          <g key={e.id} {...events} className={`${cls(e)}${ghost?.id === e.id ? " karte-ghost" : ""}${e.rack && byId[e.rack.id] && !onFace(e, face) ? " karte-otherside" : ""}`}>
            <title>{`${e.name ?? ""}${host ? ` (${host})` : ""}: ${LABEL[String(online) as keyof typeof LABEL]}`}</title>
            <rect className="karte-dev" x={b.x} y={b.y} width={b.w} height={b.h} rx={4}
              style={e.color ? { stroke: e.color, fill: e.color, fillOpacity: 0.15 } : undefined} />
            <RackFront e={e} b={b} />
            <text className="karte-name" x={b.x + 10} y={b.y + Math.min(b.h / 2 + 5, 20)}>{`${e.icon ? `${e.icon} ` : ""}${e.name ?? ""}${e.page ? " 📖" : ""}`}</text>
            {host && b.h >= 44 && <text className="karte-u" x={b.x + 10} y={b.y + 36}>{host}</text>}
            {e.check && <circle className={`karte-dot ${online === undefined ? "unknown" : online ? "up" : "down"}`} cx={b.x + b.w - 12} cy={b.y + 12} r={6} />}
            {hasPorts(e) && Array.from({ length: e.ports ?? 0 }, (_, i) => {
              const p = portPoint(b, e.ports!, i + 1);
              return <rect key={i} className="karte-port-box" x={p.x - 3} y={p.y - 3} width={6} height={6}><title>{`Port ${i + 1}`}</title></rect>;
            })}
            {editing && sel && !(e.rack && byId[e.rack.id]) && <ResizeHandle b={b} onDown={(ev) => startDrag(ev, e, "size")} />}
          </g>
        );
      })}
      {ghost?.target && <SlotHint t={ghost.target} byId={byId} />}
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
          <g key={e.id} onPointerDown={(ev) => { ev.stopPropagation(); onSelect(e.id, ev.shiftKey); }}>
            <title>{`Kabel ${fromEl.name ?? ""} → ${toEl.name ?? ""}${e.label ? `: ${e.label}` : ""}${e.medium ? ` · ${MEDIA[e.medium]?.label}` : ""}${e.vlan !== undefined ? ` · VLAN ${e.vlan}` : ""}`}</title>
            <path className="karte-hit" d={d} />
            <path className={`karte-cable${selected.includes(e.id) ? " selected" : ""}`} d={d} style={cableColor(e, cableMode) ? { stroke: cableColor(e, cableMode) } : undefined} />
            {e.label && <text className="karte-port" x={mid.x + 4} y={mid.y - 4}>{e.label}</text>}
          </g>
        );
      })}
    </svg>
  );
}

export function ResizeHandle({ b, onDown }: { b: Box; onDown: (ev: ReactPointerEvent) => void }) {
  return <rect className="karte-handle" x={b.x + b.w - 6} y={b.y + b.h - 6} width={12} height={12} onPointerDown={onDown}><title>Größe ändern</title></rect>;
}
