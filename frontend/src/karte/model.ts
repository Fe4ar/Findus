import { tr } from "../i18n";
export type ElType = "rack" | "device" | "switch" | "text" | "link";

export interface El {
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
  kind?: string; // rack device type (RACK_TYPES in rack.tsx)
  hostname?: string;
  mac?: string;
  model?: string;
  serial?: string;
  notes?: string;
  vlan?: number; // cable
  medium?: string; // cable: MEDIA key
  watt?: number; // device draw, or capacity for UPS/PDU
  weight?: number; // kg
  side?: "front" | "back" | "both"; // rack mounting side, see sideOf in rack.tsx
}

export interface PageRef {
  id: string;
  title: string;
  path: string;
}

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

// SPA navigation from inside a view: main.tsx follows popstate.
export function navigate(path: string) {
  history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export interface MapContent {
  testdaten?: boolean;
  hinweis?: string;
  elements: El[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID = 10;
export const UH = 30; // px per rack unit
export const RACK_HEAD = 26;
export const LABEL = { true: "erreichbar", false: "nicht erreichbar", undefined: "nicht geprüft" } as const;
export const TYPE_LABEL: Record<ElType, string> = { rack: "Rack", device: "Gerät", switch: "Switch", text: "Text", link: "Kabel" };

export const snap = (v: number) => Math.round(v / GRID) * GRID;
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).slice(0, 8);

export function boxOf(e: El, byId: Record<string, El>): Box | null {
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

export function portPoint(b: Box, ports: number, port: number) {
  const cols = ports > 12 ? Math.ceil(ports / 2) : ports;
  const k = Math.min(Math.max(port, 1), ports) - 1;
  const row = Math.floor(k / cols);
  const col = k % cols;
  return { x: b.x + 10 + (col * (b.w - 20)) / Math.max(cols - 1, 1), y: b.y + b.h - (ports > 12 ? 18 : 10) + row * 9 };
}

export function anchor(e: El | undefined, port: number | undefined, byId: Record<string, El>) {
  if (!e) return null;
  const b = boxOf(e, byId);
  if (!b) return null;
  if (hasPorts(e) && port && e.ports) return portPoint(b, e.ports, port);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Old maps have type "switch" without kind; both forms get ports and port anchors. */
export const kindOf = (e: El) => e.kind ?? (e.type === "switch" ? "switch" : undefined);
export const hasPorts = (e: El) => kindOf(e) === "switch" || kindOf(e) === "patch";

export const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^[0-9a-f:]*:[0-9a-f:.]+$/i;
export const MAC_RE = /^[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}$/i;

/** Cable media with their colour (used when cables are coloured by type). */
export const MEDIA: Record<string, { label: string; color: string }> = {
  cu: { label: "Kupfer", color: "#2563eb" },
  fiber: { label: "LWL", color: "#ea580c" },
  dac: { label: "DAC", color: "#7c3aed" },
  power: { label: "Strom", color: "#dc2626" },
};
export type CableMode = "none" | "medium" | "vlan";
/** Stable colour per VLAN id (golden-angle hue steps keep neighbouring ids apart). */
export const vlanColor = (vlan: number) => `hsl(${(vlan * 137.5) % 360} 65% 45%)`;
export function cableColor(e: El, mode: CableMode) {
  if (e.color) return e.color;
  if (mode === "medium" && e.medium) return MEDIA[e.medium]?.color;
  if (mode === "vlan" && e.vlan !== undefined) return vlanColor(e.vlan);
  return undefined;
}
