import { El, Box, UH, RACK_HEAD, boxOf, kindOf } from "./model";
import { tr } from "../i18n";

/** Rack device catalog: default height in U and a plain front graphic. Elements keep type "device"/"switch", kind picks the entry. */
export const RACK_TYPES: Record<string, { label: string; h: number; icon: string }> = {
  switch: { label: "Switch", h: 1, icon: "🔀" },
  router: { label: "Router", h: 1, icon: "📡" },
  firewall: { label: "Firewall", h: 1, icon: "🛡️" },
  patch: { label: "Patchpanel", h: 1, icon: "🔌" },
  shelf: { label: "Fachboden", h: 1, icon: "" },
  blank: { label: "Blindplatte", h: 1, icon: "" },
  ups: { label: "USV", h: 2, icon: "🔋" },
  pdu: { label: "PDU", h: 1, icon: "⚡" },
  server1: { label: "Server 1U", h: 1, icon: "🖥️" },
  server2: { label: "Server 2U", h: 2, icon: "🖥️" },
  server4: { label: "Server 4U", h: 4, icon: "🖥️" },
  nas: { label: "NAS", h: 2, icon: "💾" },
  kvm: { label: "KVM", h: 1, icon: "⌨️" },
  cable: { label: "Kabelführung", h: 1, icon: "" },
  monitor: { label: "Monitor-Auszug", h: 1, icon: "🖵" },
  fan: { label: "Lüftereinschub", h: 1, icon: "" },
};

const mounted = (e: El, byId: Record<string, El>) => !!(e.rack && byId[e.rack.id]?.type === "rack");

export type Face = "front" | "back";
export const SIDES = { front: "vorn", back: "hinten", both: "beide (volle Tiefe)" } as const;
/** PDUs and cable management usually sit at the back; everything else at the front. */
export const sideOf = (e: El) => e.side ?? (kindOf(e) === "pdu" || kindOf(e) === "cable" ? "back" : "front");
export const onFace = (e: El, face: Face) => sideOf(e) === "both" || sideOf(e) === face;
/** Front and back devices share a unit unless one of them takes the full depth. */
const clash = (a: El, b: El) => sideOf(a) === "both" || sideOf(b) === "both" || sideOf(a) === sideOf(b);

/** U range [lo, hi] a device covers. */
const span = (e: El) => [e.rack!.u, e.rack!.u + e.rack!.h - 1];

/** Where a device of height h, with its top edge at y, would land in the rack under (x, y); null outside every rack. */
export function rackTarget(elements: El[], byId: Record<string, El>, x: number, y: number, h: number, self: El) {
  for (const r of elements) {
    if (r.type !== "rack") continue;
    const b = boxOf(r, byId)!;
    if (x < b.x || x > b.x + b.w || y < b.y - UH / 2 || y > b.y + b.h) continue;
    const units = r.units ?? 12;
    const fromTop = Math.round((y - b.y - RACK_HEAD) / UH);
    const u = Math.min(Math.max(units - fromTop - h + 1, 1), Math.max(units - h + 1, 1));
    const free = h <= units && elements.every((e) => e.id === self.id || e.rack?.id !== r.id || !mounted(e, byId) || !clash(e, self)
      || span(e)[1] < u || span(e)[0] > u + h - 1);
    return { rack: r, u, h, free };
  }
  return null;
}

/** Lowest free position for height h in a rack, or null when it is full. */
export function firstFree(elements: El[], rack: El, h: number, self: El) {
  const units = rack.units ?? 12;
  const taken = elements.filter((e) => e.rack?.id === rack.id && e.type !== "rack" && e.id !== self.id && clash(e, self)).map(span);
  for (let u = 1; u + h - 1 <= units; u++) if (taken.every(([lo, hi]) => hi < u || lo > u + h - 1)) return u;
  return null;
}

/** Highlight for the target U slots while dragging (green free, red taken). */
export function SlotHint({ t, byId }: { t: NonNullable<ReturnType<typeof rackTarget>>; byId: Record<string, El> }) {
  const b = boxOf(t.rack, byId)!;
  const units = t.rack.units ?? 12;
  return <rect className={`karte-slot-hint${t.free ? "" : " taken"}`} x={b.x + 24} y={b.y + RACK_HEAD + (units - t.u - t.h + 1) * UH}
    width={b.w - 32} height={t.h * UH} />;
}

/** Plain front view per device kind, drawn inside the device box (stroke only, follows light/dark). */
export function RackFront({ e, b }: { e: El; b: Box }) {
  const k = kindOf(e);
  const cy = b.y + b.h / 2;
  const right = b.x + b.w - 26; // keeps the live dot free
  const row = (n: number, from: number, to: number, f: (x: number, i: number) => JSX.Element) =>
    Array.from({ length: n }, (_, i) => f(from + ((to - from) * (i + 0.5)) / n, i));
  switch (k) {
    case "router": case "firewall":
      return <g className="karte-front">{row(k === "firewall" ? 8 : 4, right - 90, right, (x, i) => <rect key={i} x={x - 4} y={cy - 4} width={8} height={8} />)}
        <circle cx={right - 104} cy={cy} r={2.5} className="karte-led" /></g>;
    case "shelf":
      return <g className="karte-front"><line x1={b.x + 4} x2={b.x + b.w - 4} y1={b.y + b.h - 4} y2={b.y + b.h - 4} /></g>;
    case "blank": case "cable":
      return <g className="karte-front">{k === "cable" && row(5, b.x + 60, right, (x, i) => <rect key={i} x={x - 8} y={cy - 5} width={16} height={10} rx={5} />)}</g>;
    case "ups": case "kvm": case "monitor":
      return <g className="karte-front"><rect x={right - 60} y={cy - 7} width={34} height={14} rx={2} />
        {k === "ups" && row(3, right - 20, right, (x, i) => <circle key={i} cx={x} cy={cy} r={2.5} />)}</g>;
    case "pdu":
      return <g className="karte-front">{row(8, b.x + 70, right, (x, i) => <rect key={i} x={x - 4} y={cy - 5} width={8} height={10} rx={1} />)}</g>;
    case "server1": case "server2": case "server4": case "nas": {
      const bays = k === "nas" ? 4 : k === "server1" ? 4 : 8;
      const rows = Math.max(1, Math.round(b.h / UH));
      return <g className="karte-front">{Array.from({ length: Math.min(rows, 2) }, (_, r) =>
        row(bays, right - 120, right, (x, i) => <rect key={`${r}-${i}`} x={x - 6} y={b.y + 6 + r * ((b.h - 12) / Math.min(rows, 2))} width={12}
          height={(b.h - 12) / Math.min(rows, 2) - 3} rx={1} />))}</g>;
    }
    case "fan":
      return <g className="karte-front">{row(3, right - 90, right, (x, i) => <circle key={i} cx={x} cy={cy} r={Math.min(b.h / 2 - 3, 11)} />)}</g>;
    default:
      return null; // switch/patch draw their port boxes in Canvas, plain devices stay plain
  }
}
