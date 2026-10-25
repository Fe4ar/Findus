import { El, PageRef, UUID_RE, MapContent, TYPE_LABEL, hasPorts, kindOf, IP_RE, MAC_RE, MEDIA } from "./model";
import { RACK_TYPES, firstFree, SIDES, sideOf } from "./rack";
import { notify } from "../Dialog";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="karte-field">{label}{children}</label>;
}

export function Props({ el, content, pages, onChange, onDelete }: {
  el: El;
  content: MapContent;
  pages: PageRef[];
  onChange: (patch: Partial<El>) => void;
  onDelete: () => void;
}) {
  const others = content.elements.filter((e) => e.type !== "link" && e.type !== "text" && e.id !== el.id);
  const racks = content.elements.filter((e) => e.type === "rack");
  const text = (k: keyof El, label: string, placeholder = "", valid?: RegExp, hint = "") => {
    const v = (el[k] as string) ?? "";
    const bad = !!(valid && v && !valid.test(v.trim()));
    return (
      <Field label={label}>
        <input value={v} placeholder={placeholder} aria-invalid={bad || undefined} onChange={(ev) => onChange({ [k]: ev.target.value })} />
        {bad && <small className="karte-invalid" role="alert">{hint}</small>}
      </Field>
    );
  };
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
        {target && hasPorts(target) && num(`${side}_port` as keyof El, "Port", 1, target.ports ?? 1)}
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
          <div className="karte-row">
            <Field label="Medium">
              <select value={el.medium ?? ""} onChange={(ev) => onChange({ medium: ev.target.value || undefined })}>
                <option value="">–</option>
                {Object.entries(MEDIA).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </Field>
            {num("vlan", "VLAN", 1, 4094)}
          </div>
        </>
      ) : el.type === "text" ? (
        <Field label="Text">
          <textarea rows={4} value={el.text ?? ""} onChange={(ev) => onChange({ text: ev.target.value })} />
        </Field>
      ) : (
        <>
          {text("name", "Name")}
          {el.type !== "rack" && (
            <Field label="Gerätetyp">
              <select value={kindOf(el) ?? ""} onChange={(ev) => {
                const t = RACK_TYPES[ev.target.value];
                onChange({ kind: ev.target.value || undefined, ...(t && !el.icon ? { icon: t.icon || undefined } : {}),
                  ...(t && el.rack ? { rack: { ...el.rack, h: t.h } } : {}),
                  ...((ev.target.value === "switch" || ev.target.value === "patch") && !el.ports ? { ports: 24 } : {}) });
              }}>
                <option value="">– allgemein –</option>
                {Object.entries(RACK_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
              </select>
            </Field>
          )}
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
          {hasPorts(el) && num("ports", "Ports", 1, 52)}
          {el.type !== "rack" && (
            <>
              {text("ip", "IP-Adresse", "192.0.2.10", IP_RE, "Keine gültige IPv4/IPv6-Adresse.")}
              {text("hostname", "Hostname", "server1.example.org")}
              {text("mac", "MAC-Adresse", "aa:bb:cc:dd:ee:ff", MAC_RE, "Format: aa:bb:cc:dd:ee:ff")}
              <div className="karte-row">
                {text("model", "Modell")}
                {text("serial", "Seriennummer")}
              </div>
              <div className="karte-row">
                {num("watt", kindOf(el) === "ups" || kindOf(el) === "pdu" ? "Kapazität (W)" : "Leistung (W)", 0, 100000)}
                {num("weight", "Gewicht (kg)", 0, 2000)}
              </div>
              {text("check", "Live-Check", "https://… oder tcp://host:port")}
              <Field label="Im Rack">
                <select value={el.rack?.id ?? ""} onChange={(ev) => {
                  const rack = racks.find((r) => r.id === ev.target.value);
                  if (!rack) return onChange({ rack: undefined });
                  const h = el.rack?.h ?? RACK_TYPES[kindOf(el) ?? ""]?.h ?? 1;
                  const u = firstFree(content.elements, rack, h, el);
                  if (u === null) return notify(`In „${rack.name || "Rack"}“ sind keine ${h} HE frei.`);
                  onChange({ rack: { id: rack.id, u, h } });
                }}>
                  <option value="">– frei platziert –</option>
                  {racks.map((r) => <option key={r.id} value={r.id}>{r.name || "Rack"}</option>)}
                </select>
              </Field>
              {el.rack && (
                <Field label="Einbauseite">
                  <select value={sideOf(el)} onChange={(ev) => onChange({ side: ev.target.value as El["side"] })}>
                    {Object.entries(SIDES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </Field>
              )}
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
      {el.type !== "link" && el.type !== "text" && (
        <Field label="Notizen">
          <textarea rows={3} value={el.notes ?? ""} onChange={(ev) => onChange({ notes: ev.target.value || undefined })} />
        </Field>
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
