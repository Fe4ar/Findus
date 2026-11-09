import { useEffect, useRef, useState } from "react";
import { api, ApiError, NodeSummary } from "./api";
import { notify } from "./Dialog";

interface Shares { shared: { team: number; name: string; edit: boolean }[]; can_manage: boolean; owner: string | null; teams: { id: number; name: string }[] }

/** "An anderes Team freigeben": the team leader picks the teams that may see (or edit) a folder of the own team. */
export function ShareDialog({ node, onClose, onSaved }: { node: NodeSummary; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Shares | null>(null);
  const [chosen, setChosen] = useState<Record<number, boolean>>({}); // team id -> may edit (absent = not shared)
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    api<Shares>(`/api/nodes/${node.id}/shares`).then((d) => { setData(d); setChosen(Object.fromEntries(d.shared.map((s) => [s.team, s.edit]))); })
      .catch((e) => { notify(e instanceof ApiError ? e.message : "Freigaben konnten nicht geladen werden."); ref.current?.close(); });
  }, [node.id]);
  const save = async () => {
    try {
      await api(`/api/nodes/${node.id}/shares`, { method: "PUT", body: { teams: Object.entries(chosen).map(([team, edit]) => ({ team: +team, edit })) } });
      notify("Freigabe gespeichert.", false);
      ref.current?.close();
      onSaved();
    } catch (e) { notify(e instanceof ApiError ? e.message : "Speichern fehlgeschlagen."); }
  };
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="share-title" onClose={onClose}>
      <h2 id="share-title">„{node.title}“ freigeben</h2>
      {!data ? <p className="muted">Lade …</p> : (
        <>
          <p className="muted small">Mitglieder der gewählten Teams sehen diesen Ordner und alles darin. Mit „darf bearbeiten“ schreiben auch ihre
            Schreibberechtigten mit. Der Ordner bleibt im Bereich von {data.owner}; nur ihr verschiebt oder löscht ihn.</p>
          {data.teams.length === 0 ? <p className="empty">Es gibt kein anderes Team.</p> : (
            <ul className="share-list">
              {data.teams.map((t) => (
                <li key={t.id}>
                  <label className="check-row"><input type="checkbox" checked={t.id in chosen}
                    onChange={(e) => setChosen((c) => { const n = { ...c }; if (e.target.checked) n[t.id] = false; else delete n[t.id]; return n; })} /> {t.name}</label>
                  <label className="check-row small"><input type="checkbox" disabled={!(t.id in chosen)} checked={chosen[t.id] === true}
                    onChange={(e) => setChosen((c) => ({ ...c, [t.id]: e.target.checked }))} /> darf bearbeiten</label>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <span className="spacer" />
            <button type="button" onClick={() => ref.current?.close()}>Abbrechen</button>
            <button className="primary" onClick={save} disabled={!data.can_manage}>Speichern</button>
          </div>
        </>
      )}
    </dialog>
  );
}
