import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, formatDate } from "./api";
import { confirmDialog, notify } from "./Dialog";
import { tr } from "./i18n";

// "Integrationen" in the account menu: connect the personal Todoist account. The token goes to the server once and is
// never shown again; this dialog only learns whether there is a connection, since when and how the last run went.

interface State {
  allowed: boolean; connected: boolean; since?: string; project?: { id: string; name: string };
  include_private?: boolean; import_new?: boolean; last_sync_at?: string | null; last_error?: string; last_error_at?: string | null;
}
interface Project { id: string; name: string }

const message = (e: unknown) => (e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen."));

export function Integrations({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [s, setS] = useState<State | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const load = useCallback(() => api<State>("/api/integrations/todoist").then(setS).catch((e) => setError(message(e))), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (s?.connected) api<Project[]>("/api/integrations/todoist/projects").then(setProjects).catch(() => setProjects([]));
  }, [s?.connected, s?.project?.id]);

  const run = async (what: string, fn: () => Promise<State | void>) => {
    setBusy(what); setError("");
    try { const r = await fn(); if (r) setS(r); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  };
  const connect = () => run("connect", async () => { const r = await api<State>("/api/integrations/todoist", { method: "POST", body: { token } }); setToken(""); return r; });
  const change = (body: object) => run("save", () => api<State>("/api/integrations/todoist", { method: "PATCH", body }));
  const changeProject = async (id: string) => {
    if (await confirmDialog({ title: tr("Anderes Todoist-Projekt?"), message: tr("Die Verknüpfungen werden neu aufgebaut. Aufgaben in Findus und in Todoist bleiben bestehen."), ok: tr("Wechseln") })) change({ project_id: id });
  };
  const disconnect = async () => {
    if (await confirmDialog({ title: tr("Todoist trennen?"), message: tr("Der Token wird gelöscht. Die Aufgaben bleiben in Findus und in Todoist, es gibt nur keinen Abgleich mehr."), ok: tr("Trennen"), danger: true }))
      run("disconnect", () => api<State>("/api/integrations/todoist", { method: "DELETE" }));
  };
  return (
    <dialog ref={ref} className="dialog modal wide" aria-labelledby="integrations-title" onClose={onClose}>
      <h2 id="integrations-title">{tr("Integrationen")}</h2>
      <section className="integration" aria-label={tr("Todoist")}>
        <h3>{tr("Todoist")}</h3>
        {!s ? <p className="muted">{tr("Lade …")}</p> : !s.connected ? (
          <>
            <p className="muted">{tr("Deine Findus-Aufgaben erscheinen in einem Todoist-Projekt „Findus“, und Änderungen laufen in beide Richtungen (erledigen, wieder öffnen, Titel, Datum). Es werden nur Aufgaben in diesem Projekt gelesen oder geändert.")}</p>
            <label className="field">{tr("Persönlicher API-Token")}<input type="password" value={token} autoComplete="off" spellCheck={false} placeholder={tr("aus Todoist: Einstellungen → Integrationen → Entwickler")}
                onChange={(e) => setToken(e.target.value)} />
            </label>
            <p className="muted small">{tr("Der Token wird verschlüsselt gespeichert und nie wieder angezeigt. Du kannst die Verbindung jederzeit trennen.")}</p>
            <div className="actions"><span className="spacer" /><button className="primary" disabled={!token.trim() || !!busy} onClick={connect}>{busy === "connect" ? tr("Verbinde …") : tr("Todoist verbinden")}</button></div>
          </>
        ) : (
          <>
            <p><span className="chip ok">{tr("Verbunden")}</span> {tr("seit")}{" "}{formatDate(s.since!)}</p>
            <div className="form-grid">
              <label className="field">{tr("Todoist-Projekt")}<select value={s.project?.id} onChange={(e) => changeProject(e.target.value)} disabled={!!busy}>
                  {projects.length ? projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>) : <option value={s.project?.id}>{s.project?.name}</option>}
                </select>
              </label>
            </div>
            <label className="check-row"><input type="checkbox" checked={!!s.include_private} disabled={!!busy} onChange={(e) => change({ include_private: e.target.checked })} /> {tr("Auch private Findus-Aufgaben übertragen")}</label>
            <label className="check-row"><input type="checkbox" checked={!!s.import_new} disabled={!!busy} onChange={(e) => change({ import_new: e.target.checked })} /> {tr("Neue Todoist-Aufgaben aus dem Projekt in Findus anlegen")}</label>
            <p className="muted small">{s.last_sync_at ? tr("Letzter Abgleich: {v}.", { v: formatDate(s.last_sync_at) }) : tr("Noch nicht abgeglichen.")} {tr("Findus gleicht alle 5 Minuten ab.")}</p>
            {s.last_error && (
              <p className="error" role="alert">{s.last_error}{s.last_error_at && <small> ({formatDate(s.last_error_at)})</small>} {tr("Deine Aufgaben sind unverändert; Änderungen werden nachgeholt.")}</p>
            )}
            <div className="actions">
              <button className="danger" disabled={!!busy} onClick={disconnect}>{tr("Trennen")}</button>
              <span className="spacer" />
              <button className="primary" disabled={!!busy} onClick={() => run("sync", () => api<State>("/api/integrations/todoist/sync", { method: "POST" }))}>{busy === "sync" ? tr("Gleiche ab …") : tr("Jetzt abgleichen")}</button>
            </div>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <div className="actions"><span className="spacer" /><button onClick={() => ref.current?.close()}>{tr("Schließen")}</button></div>
    </dialog>
  );
}
