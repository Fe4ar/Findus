import { useEffect, useState } from "react";
import { api, ApiError, NodeDetail } from "./api";
import { notify } from "./Dialog";

type Flag = "can_read" | "can_write" | "can_publish" | "can_manage";
type Flags = Record<Flag, boolean>;
interface GroupRights {
  id: number;
  name: string;
  own: Flags | null;
  inherited: Flags;
}

// Short headers keep the table inside the narrow meta panel; the legend below spells them out.
const FLAGS: [Flag, string, string][] = [
  ["can_read", "Lesen", "L"], ["can_write", "Schreiben", "S"], ["can_publish", "Veröffentlichen", "V"], ["can_manage", "Rechte verwalten", "R"],
];
const NONE: Flags = { can_read: false, can_write: false, can_publish: false, can_manage: false };

// Group rights on an area or folder. Rights add up from above, so inherited ones show as checked and locked.
export function Rights({ node, onSaved }: { node: NodeDetail; onSaved: (n: NodeDetail) => void }) {
  const [groups, setGroups] = useState<GroupRights[] | null>(null);
  const [saving, setSaving] = useState(false);
  const manage = node.permissions.manage && (node.kind === "area" || node.kind === "folder");

  useEffect(() => {
    if (manage) api<{ groups: GroupRights[] }>(`/api/nodes/${node.id}/permissions`).then((r) => setGroups(r.groups));
  }, [node.id, manage]);
  if (!manage || !groups) return null;

  async function save(next: GroupRights[]) {
    setSaving(true);
    try {
      const rows = next.filter((g) => g.own).map((g) => ({ group: g.id, ...g.own }));
      setGroups((await api<{ groups: GroupRights[] }>(`/api/nodes/${node.id}/permissions`, { method: "PUT", body: { rows } })).groups);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen.");
    }
    setSaving(false);
  }

  const toggle = (g: GroupRights, flag: Flag) =>
    save(groups.map((x) => (x.id === g.id ? { ...x, own: { ...(x.own ?? NONE), [flag]: !(x.own ?? NONE)[flag] } } : x)));

  return (
    <section className="rights" aria-label="Rechte">
      <h3>Rechte</h3>
      {node.kind === "area" && node.space === "wiki" && node.is_public && (
        <label className="rights-public">
          <input type="checkbox" checked={node.is_public} disabled={saving} onChange={async (e) => {
            try {
              onSaved(await api(`/api/nodes/${node.id}`, { method: "PATCH", body: { is_public: e.target.checked } }));
            } catch (err) {
              notify(err instanceof ApiError ? err.message : "Speichern fehlgeschlagen.");
            }
          }} />
          Öffentlich (ohne Anmeldung lesbar, nur veröffentlichte Inhalte)
        </label>
      )}
      <table>
        <thead>
          <tr><th>Gruppe</th>{FLAGS.map(([, label, short]) => <th key={short}><abbr title={label}>{short}</abbr></th>)}</tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>{g.name}</td>
              {FLAGS.map(([flag, label]) => {
                const inherited = g.inherited[flag];
                return (
                  <td key={flag}>
                    <input type="checkbox" aria-label={`${g.name}: ${label}`} disabled={saving || inherited}
                      title={inherited ? "Geerbt von oben" : undefined}
                      checked={inherited || !!g.own?.[flag]} onChange={() => toggle(g, flag)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">L Lesen, S Schreiben, V Veröffentlichen, R Rechte verwalten. Ausgegraut = geerbt (von oben oder global). Gilt für alles darunter.</p>
    </section>
  );
}
