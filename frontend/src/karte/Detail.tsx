import { useEffect, useRef } from "react";
import { El, MapContent, LABEL, TYPE_LABEL, kindOf, hasPorts, navigate, vlanColor } from "./model";
import { RACK_TYPES, SIDES, sideOf } from "./rack";

/** Where the device sits: rack name and unit range. */
export function location(el: El, content: MapContent) {
  const rack = el.rack && content.elements.find((e) => e.id === el.rack!.id && e.type === "rack");
  if (!rack) return "frei platziert";
  const { u, h } = el.rack!;
  return `${rack.name || "Rack"}, HE ${h > 1 ? `${u}–${u + h - 1}` : u}, ${SIDES[sideOf(el)]}`;
}

/** Read-only device facts, shared by the side panel and the modal. */
export function Facts({ el, content, status }: { el: El; content: MapContent; status: Record<string, boolean> }) {
  const cables = content.elements.filter((e) => e.type === "link" && (e.from === el.id || e.to === el.id));
  const name = (id?: string) => content.elements.find((e) => e.id === id)?.name ?? "?";
  const rows: [string, React.ReactNode][] = [
    ["Typ", RACK_TYPES[kindOf(el) ?? ""]?.label ?? TYPE_LABEL[el.type]],
    ["IP-Adresse", el.ip], ["Hostname", el.hostname], ["MAC", el.mac && <code>{el.mac}</code>],
    ["Modell", el.model], ["Seriennummer", el.serial],
    ["Standort", el.type === "rack" ? `${el.units ?? 12} HE` : location(el, content)],
    ["Ports", el.ports], ["Live-Status", el.check ? LABEL[String(status[el.id]) as keyof typeof LABEL] : undefined],
    ["Kabel", cables.length ? <ul>{cables.map((c) => (
      <li key={c.id}>{c.from === el.id ? `→ ${name(c.to)}` : `← ${name(c.from)}`}{c.label ? ` (${c.label})` : ""}</li>
    ))}</ul> : undefined],
    ["Leistung", el.watt !== undefined && el.type !== "rack" ? `${el.watt} W` : undefined],
    ["Gewicht", el.weight !== undefined ? `${el.weight} kg` : undefined],
    ["Notizen", el.notes && <span className="karte-notes">{el.notes}</span>],
    ...(el.type === "rack" ? rackMetrics(el, content) : []),
  ];
  return (
    <>
      <dl className="karte-facts">
        {rows.filter(([, v]) => v !== undefined && v !== "" && v !== null).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {hasPorts(el) && !!el.ports && <PortGrid el={el} content={content} />}
    </>
  );
}

/** Rack key figures: units in use, power draw against UPS (or PDU) capacity, weight. */
function rackMetrics(rack: El, content: MapContent): [string, React.ReactNode][] {
  const devs = content.elements.filter((e) => e.rack?.id === rack.id && e.type !== "rack");
  const units = rack.units ?? 12;
  // a unit counts as used when anything sits in it, front or back
  const used = new Set(devs.flatMap((e) => Array.from({ length: e.rack!.h }, (_, i) => e.rack!.u + i))).size;
  const sum = (list: El[], k: "watt" | "weight") => list.reduce((n, e) => n + (e[k] ?? 0), 0);
  const supply = devs.filter((e) => kindOf(e) === "ups");
  const capacity = sum(supply.length ? supply : devs.filter((e) => kindOf(e) === "pdu"), "watt");
  const draw = sum(devs.filter((e) => kindOf(e) !== "ups" && kindOf(e) !== "pdu"), "watt");
  const weight = sum(devs, "weight") + (rack.weight ?? 0);
  return [
    ["Belegung", <span>{used} von {units} HE belegt, {units - used} frei <meter min={0} max={units} value={used} /></span>],
    ["Leistung", draw || capacity ? <span className={capacity && draw > capacity ? "karte-invalid" : undefined}>
      {draw} W{capacity ? ` von ${capacity} W (${Math.round((draw / capacity) * 100)} %)` : " (keine USV/PDU-Kapazität eingetragen)"}
    </span> : undefined],
    ["Gewicht", weight ? `${weight} kg` : undefined],
  ];
}

/** Port occupancy derived from the cables that name a port of this switch/patch panel. */
function PortGrid({ el, content }: { el: El; content: MapContent }) {
  const name = (id?: string) => content.elements.find((e) => e.id === id)?.name ?? "?";
  const ports = Array.from({ length: el.ports! }, (_, i) => {
    const p = i + 1;
    const c = content.elements.find((e) => e.type === "link" && ((e.from === el.id && e.from_port === p) || (e.to === el.id && e.to_port === p)));
    return { p, c, peer: c && name(c.from === el.id ? c.to : c.from) };
  });
  const used = ports.filter((x) => x.c);
  return (
    <div className="karte-ports">
      <h4>Ports ({used.length} von {ports.length} belegt)</h4>
      <ol className="karte-port-grid" style={{ gridTemplateColumns: `repeat(${el.ports! > 12 ? Math.ceil(el.ports! / 2) : el.ports}, 1.6rem)` }}>
        {ports.map(({ p, c, peer }) => (
          <li key={p} className={c ? "used" : undefined} title={c ? `Port ${p} → ${peer}${c.vlan !== undefined ? `, VLAN ${c.vlan}` : ""}${c.label ? `, ${c.label}` : ""}` : `Port ${p}: frei`}
            style={c?.vlan !== undefined ? { background: vlanColor(c.vlan) } : undefined}>{p}</li>
        ))}
      </ol>
      {!!used.length && (
        <ul className="karte-port-list">
          {used.map(({ p, c, peer }) => <li key={p}>Port {p} → {peer}{c!.vlan !== undefined ? ` · VLAN ${c!.vlan}` : ""}{c!.label ? ` · ${c!.label}` : ""}</li>)}
        </ul>
      )}
    </div>
  );
}

export function DetailPanel({ el, content, status, onOpen, onDiagram, diagramOpen }: {
  el: El; content: MapContent; status: Record<string, boolean>; onOpen: () => void; onDiagram: () => void; diagramOpen: boolean;
}) {
  return (
    <aside className="karte-props karte-detail" aria-label="Gerätedetails">
      <h3>{el.icon ? `${el.icon} ` : ""}{el.name || TYPE_LABEL[el.type]}</h3>
      <Facts el={el} content={content} status={status} />
      <div className="actions">
        {el.page && <button onClick={() => navigate(`/n/${el.page}`)}>📖 Seite öffnen</button>}
        {el.diagram && <button aria-expanded={diagramOpen} onClick={onDiagram}>📐 Schaubild {diagramOpen ? "schließen" : "öffnen"}</button>}
        <button onClick={onOpen}>Alle Details</button>
      </div>
    </aside>
  );
}

/** Large view on double click; children are the editable fields in edit mode. */
export function DetailModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="modal karte-modal" aria-label={title} onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) ref.current.close(); }}>
      <div className="page-head">
        <h2>{title}</h2>
        <button aria-label="Schließen" onClick={() => ref.current?.close()}>×</button>
      </div>
      {children}
    </dialog>
  );
}
