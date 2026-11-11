import { useEffect, useRef } from "react";
import { El, MapContent, LABEL, TYPE_LABEL, kindOf, hasPorts, navigate, vlanColor } from "./model";
import { RACK_TYPES, SIDES, sideOf } from "./rack";
import { tr } from "../i18n";

/** Where the device sits: rack name and unit range. */
export function location(el: El, content: MapContent) {
  const rack = el.rack && content.elements.find((e) => e.id === el.rack!.id && e.type === "rack");
  if (!rack) return tr("frei platziert");
  const { u, h } = el.rack!;
  return `${rack.name || "Rack"}, HE ${h > 1 ? `${u}–${u + h - 1}` : u}, ${tr(SIDES[sideOf(el)])}`;
}

/** Read-only device facts, shared by the side panel and the modal. */
export function Facts({ el, content, status }: { el: El; content: MapContent; status: Record<string, boolean> }) {
  const cables = content.elements.filter((e) => e.type === "link" && (e.from === el.id || e.to === el.id));
  const name = (id?: string) => content.elements.find((e) => e.id === id)?.name ?? "?";
  const rows: [string, React.ReactNode][] = [
    [tr("Typ"), tr(RACK_TYPES[kindOf(el) ?? ""]?.label ?? TYPE_LABEL[el.type])],
    [tr("IP-Adresse"), el.ip], [tr("Hostname"), el.hostname], ["MAC", el.mac && <code>{el.mac}</code>],
    [tr("Modell"), el.model], [tr("Seriennummer"), el.serial],
    [tr("Standort"), el.type === "rack" ? `${el.units ?? 12} HE` : location(el, content)],
    [tr("Ports"), el.ports], [tr("Live-Status"), el.check ? tr(LABEL[String(status[el.id]) as keyof typeof LABEL]) : undefined],
    [tr("Kabel"), cables.length ? <ul>{cables.map((c) => (
      <li key={c.id}>{c.from === el.id ? `→ ${name(c.to)}` : `← ${name(c.from)}`}{c.label ? ` (${c.label})` : ""}</li>
    ))}</ul> : undefined],
    [tr("Leistung"), el.watt !== undefined && el.type !== "rack" ? `${el.watt} W` : undefined],
    [tr("Gewicht"), el.weight !== undefined ? `${el.weight} kg` : undefined],
    [tr("Notizen"), el.notes && <span className="karte-notes">{el.notes}</span>],
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
    [tr("Belegung"), <span>{used} {tr("von")}{" "}{units} {tr("HE belegt,")}{" "}{units - used} {tr("frei")}{" "}<meter min={0} max={units} value={used} /></span>],
    [tr("Leistung"), draw || capacity ? <span className={capacity && draw > capacity ? "karte-invalid" : undefined}>
      {draw} W{capacity ? tr(" von {capacity} W ({v} %)", { capacity, v: Math.round((draw / capacity) * 100) }) : tr(" (keine USV/PDU-Kapazität eingetragen)")}
    </span> : undefined],
    [tr("Gewicht"), weight ? `${weight} kg` : undefined],
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
      <h4>{tr("Ports (")}{used.length} {tr("von")}{" "}{ports.length} {tr("belegt)")}</h4>
      <ol className="karte-port-grid" style={{ gridTemplateColumns: `repeat(${el.ports! > 12 ? Math.ceil(el.ports! / 2) : el.ports}, 1.6rem)` }}>
        {ports.map(({ p, c, peer }) => (
          <li key={p} className={c ? "used" : undefined} title={c ? tr("Port {p} → {peer}{v}{v2}", { p, peer, v: c.vlan !== undefined ? `, VLAN ${c.vlan}` : "", v2: c.label ? `, ${c.label}` : "" }) : tr("Port {p}: frei", { p })}
            style={c?.vlan !== undefined ? { background: vlanColor(c.vlan) } : undefined}>{p}</li>
        ))}
      </ol>
      {!!used.length && (
        <ul className="karte-port-list">
          {used.map(({ p, c, peer }) => <li key={p}>{tr("Port")}{" "}{p} → {peer}{c!.vlan !== undefined ? tr(" · VLAN {vlan}", { vlan: c!.vlan }) : ""}{c!.label ? ` · ${c!.label}` : ""}</li>)}
        </ul>
      )}
    </div>
  );
}

export function DetailPanel({ el, content, status, onOpen, onDiagram, diagramOpen }: {
  el: El; content: MapContent; status: Record<string, boolean>; onOpen: () => void; onDiagram: () => void; diagramOpen: boolean;
}) {
  return (
    <aside className="karte-props karte-detail" aria-label={tr("Gerätedetails")}>
      <h3>{el.icon ? `${el.icon} ` : ""}{el.name || tr(TYPE_LABEL[el.type])}</h3>
      <Facts el={el} content={content} status={status} />
      <div className="actions">
        {el.page && <button onClick={() => navigate(`/n/${el.page}`)}>{tr("📖 Seite öffnen")}</button>}
        {el.diagram && <button aria-expanded={diagramOpen} onClick={onDiagram}>{tr("📐 Schaubild")}{" "}{diagramOpen ? tr("schließen") : tr("öffnen")}</button>}
        <button onClick={onOpen}>{tr("Alle Details")}</button>
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
        <button aria-label={tr("Schließen")} onClick={() => ref.current?.close()}>×</button>
      </div>
      {children}
    </dialog>
  );
}
