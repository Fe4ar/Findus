import { useEffect, useRef, useState } from "react";
import { api, ApiError, NodeSummary } from "./api";
import { notify } from "./Dialog";
import { tr } from "./i18n";

interface Shares {
  shared: { team: number; name: string; edit: boolean }[];
  users: { user: number; name: string; edit: boolean }[];
  can_manage: boolean; owner: string | null; teams: { id: number; name: string }[]; private: boolean;
}
interface Person { id: number; name: string; username: string }

/** "Freigeben": the team leader picks the teams that may see (or edit) a folder of the own team; the owner of a private folder
 *  picks teams and single users the same way. Rights to manage are never handed out. */
export function ShareDialog({ node, onClose, onSaved }: { node: NodeSummary; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<Shares | null>(null);
  const [chosen, setChosen] = useState<Record<number, boolean>>({}); // team id -> may edit (absent = not shared)
  const [people, setPeople] = useState<Record<number, { name: string; edit: boolean }>>({}); // user id -> name, may edit
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Person[]>([]);
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    api<Shares>(`/api/nodes/${node.id}/shares`).then((d) => {
      setData(d);
      setChosen(Object.fromEntries(d.shared.map((s) => [s.team, s.edit])));
      setPeople(Object.fromEntries(d.users.map((u) => [u.user, { name: u.name, edit: u.edit }])));
    }).catch((e) => { notify(e instanceof ApiError ? e.message : tr("Freigaben konnten nicht geladen werden.")); ref.current?.close(); });
  }, [node.id]);
  useEffect(() => {
    if (q.trim().length < 2) return setFound([]);
    const t = setTimeout(() => api<Person[]>(`/api/people?q=${encodeURIComponent(q.trim())}`).then(setFound).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  const save = async () => {
    try {
      await api(`/api/nodes/${node.id}/shares`, { method: "PUT", body: {
        teams: Object.entries(chosen).map(([team, edit]) => ({ team: +team, edit })),
        ...(data?.private ? { users: Object.entries(people).map(([user, p]) => ({ user: +user, edit: p.edit })) } : {}),
      } });
      notify(tr("Freigabe gespeichert."), false);
      ref.current?.close();
      onSaved();
    } catch (e) { notify(e instanceof ApiError ? e.message : tr("Speichern fehlgeschlagen.")); }
  };
  const priv = !!data?.private;
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="share-title" onClose={onClose}>
      <h2 id="share-title">„{node.title}{tr("“ freigeben")}</h2>
      {!data ? <p className="muted">{tr("Lade …")}</p> : (
        <>
          <p className="muted small">{priv
            ? tr("Wen du hier wählst, sieht diesen Ordner und alles darin; der Ordner bleibt in deinem privaten Bereich, ohne Freigabe sieht ihn niemand (auch kein Admin). Mit „darf bearbeiten“ schreiben die Gewählten mit. Weitergeben oder Rechte ändern können sie nicht; du nimmst die Freigabe jederzeit zurück.")
            : tr("Mitglieder der gewählten Teams sehen diesen Ordner und alles darin. Mit „darf bearbeiten“ schreiben auch ihre Schreibberechtigten mit. Der Ordner bleibt im Bereich von {owner}; nur ihr verschiebt oder löscht ihn.", { owner: data.owner })}</p>
          {priv && (
            <fieldset className="share-users">
              <legend>{tr("Benutzer")}</legend>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Benutzer suchen (mind. 2 Buchstaben) …")} aria-label={tr("Benutzer suchen")} autoComplete="off" />
              {found.filter((p) => !(p.id in people)).length > 0 && (
                <ul className="share-found" aria-label={tr("Treffer")}>
                  {found.filter((p) => !(p.id in people)).map((p) => (
                    <li key={p.id}><span>{p.name}{p.name !== p.username && <small className="muted"> · {p.username}</small>}</span>
                      <button type="button" onClick={() => { setPeople((c) => ({ ...c, [p.id]: { name: p.name, edit: false } })); setQ(""); setFound([]); }}>{tr("Hinzufügen")}</button></li>
                  ))}
                </ul>
              )}
              <ul className="share-list">
                {Object.entries(people).map(([id, p]) => (
                  <li key={id}>
                    <span>{p.name}</span>
                    <label className="check-row small"><input type="checkbox" checked={p.edit} onChange={(e) => setPeople((c) => ({ ...c, [+id]: { ...p, edit: e.target.checked } }))} /> {tr("darf bearbeiten")}</label>
                    <button type="button" className="icon-btn" aria-label={tr("{name} entfernen", { name: p.name })} title={tr("Freigabe zurücknehmen")} onClick={() => setPeople((c) => { const n = { ...c }; delete n[+id]; return n; })}>✕</button>
                  </li>
                ))}
              </ul>
              {Object.keys(people).length === 0 && <p className="muted small">{tr("Noch niemand ausgewählt.")}</p>}
            </fieldset>
          )}
          {priv && <h3 className="share-sub">{tr("Teams")}</h3>}
          {data.teams.length === 0 ? <p className="empty">{tr("Es gibt kein anderes Team.")}</p> : (
            <ul className="share-list">
              {data.teams.map((t) => (
                <li key={t.id}>
                  <label className="check-row"><input type="checkbox" checked={t.id in chosen}
                    onChange={(e) => setChosen((c) => { const n = { ...c }; if (e.target.checked) n[t.id] = false; else delete n[t.id]; return n; })} /> {t.name}</label>
                  <label className="check-row small"><input type="checkbox" disabled={!(t.id in chosen)} checked={chosen[t.id] === true}
                    onChange={(e) => setChosen((c) => ({ ...c, [t.id]: e.target.checked }))} /> {tr("darf bearbeiten")}</label>
                </li>
              ))}
            </ul>
          )}
          <div className="actions">
            <span className="spacer" />
            <button type="button" onClick={() => ref.current?.close()}>{tr("Abbrechen")}</button>
            <button className="primary" onClick={save} disabled={!data.can_manage}>{tr("Speichern")}</button>
          </div>
        </>
      )}
    </dialog>
  );
}
