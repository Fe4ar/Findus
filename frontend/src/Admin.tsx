import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, formatDate, formatSize, Me } from "./api";
import { ask, confirmDialog, notify } from "./Dialog";
import { Icon, IconName } from "./Icons";
import { tr, trs } from "./i18n";

// Admin menu: side navigation with Benutzer, Teams, Rechte, Papierkorb, Protokoll and System.
// Admins see everything; team leaders and writers get the parts for their own teams (the API enforces this).

export interface Section { id: string; label: string; icon: IconName; show: (me: Me) => boolean }
const lead = (me: Me) => !!me.teams?.some((t) => t.leader);
export const SECTIONS: Section[] = [
  { id: "statistik", label: "Statistik", icon: "chart", show: (m) => !!m.is_admin || lead(m) },
  { id: "benutzer", label: "Benutzer", icon: "user", show: (m) => !!m.is_admin },
  { id: "teams", label: "Teams", icon: "users", show: (m) => !!m.is_admin || lead(m) },
  { id: "papierkorb", label: "Papierkorb", icon: "trash", show: (m) => !!m.is_admin || !!m.teams?.some((t) => t.can_write) },
  { id: "protokoll", label: "Protokoll", icon: "clipboard", show: (m) => !!m.is_admin || lead(m) },
  { id: "system", label: "System", icon: "gear", show: (m) => !!m.is_admin },
  { id: "info", label: "Info", icon: "info", show: (m) => !!m.is_admin || lead(m) },
];
export const adminAllowed = (me: Me) => SECTIONS.some((s) => s.show(me));

const err = (e: unknown) => notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen."));

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className={`dialog modal${wide ? " wide" : ""}`} aria-label={title} onClose={onClose}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

const sectionOf = (me: Me, path: string) => {
  const visible = SECTIONS.filter((s) => s.show(me));
  return visible.find((s) => path.split("?")[0].startsWith(`/verwaltung/${s.id}`)) ?? visible[0];
};

/** Side navigation of the admin menu; it lives in the app's permanent sidebar, never in a tab. */
export function AdminNav({ me, path, go }: { me: Me; path: string; go: (p: string) => void }) {
  const current = sectionOf(me, path);
  return (
    <div className="admin-nav">
      <div className="admin-nav-title">{tr("Verwaltung")}</div>
      {SECTIONS.filter((s) => s.show(me)).map((s) => (
        <a key={s.id} href={`/verwaltung/${s.id}`} aria-current={s.id === current?.id ? "page" : undefined}
          onClick={(e) => { if (e.ctrlKey || e.metaKey || e.button === 1) return; e.preventDefault(); go(`/verwaltung/${s.id}`); }}>
          <Icon name={s.icon} /> {tr(s.label)}
        </a>
      ))}
      {me.is_admin && <a href="/admin/" className="admin-nav-ext">{tr("Django-Admin")}{" "}<Icon name="external" size={14} /></a>}
    </div>
  );
}

export function Admin({ me, path, go }: { me: Me; path: string; go: (p: string) => void }) {
  const current = sectionOf(me, path);
  if (!current) return <p className="muted">{tr("Keine Berechtigung.")}</p>;
  return (
    <div className="admin-body">
      <h1>{tr(current.label)}</h1>
      {current.id === "statistik" && <Stats />}
      {current.id === "benutzer" && <Users go={go} me={me} />}
      {current.id === "teams" && <Teams me={me} go={go} />}
      {current.id === "papierkorb" && <Trash />}
      {current.id === "protokoll" && <Audit />}
      {current.id === "system" && <System />}
      {current.id === "info" && <Info />}
    </div>
  );
}

// --- Benutzer ----------------------------------------------------------------------------------------------

interface UserRow {
  id: number; username: string; name: string; first_name: string; last_name: string; email: string; is_active: boolean;
  is_superuser: boolean; groups: string[]; teams: { id: number; name: string; leader: boolean; can_write: boolean }[];
  can_download: boolean; must_change_password: boolean; last_login: string | null; deleted_at: string | null; purge_at: string | null;
}
interface Group { id: number; name: string }

// Draft of the "Neuer Benutzer" dialog: survives closing it and leaving the page; the password is never stored.
const DRAFT_KEY = "findus-user-draft";
interface Draft { f: { username: string; first_name: string; last_name: string; email: string }; sel: number[]; selTeams: number[] }
const readDraft = (): Draft | null => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; } };
const writeDraft = (d: Draft | null) => { try { d ? sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)) : sessionStorage.removeItem(DRAFT_KEY); } catch { /* storage blocked: no draft */ } };

// Same pattern for "Neues Team"; RETURN_KEY carries the hop Team -> Neuer Benutzer -> back to the team.
const TEAM_DRAFT_KEY = "findus-team-draft", RETURN_KEY = "findus-draft-return";
interface TeamDraft { name: string; members: Member[] }
const readTeamDraft = (): TeamDraft | null => { try { return JSON.parse(sessionStorage.getItem(TEAM_DRAFT_KEY) || "null"); } catch { return null; } };
const writeTeamDraft = (d: TeamDraft | null) => { try { d ? sessionStorage.setItem(TEAM_DRAFT_KEY, JSON.stringify(d)) : sessionStorage.removeItem(TEAM_DRAFT_KEY); } catch { /* storage blocked: no draft */ } };
const getReturn = () => { try { return sessionStorage.getItem(RETURN_KEY); } catch { return null; } };
const setReturn = (v: string | null) => { try { v ? sessionStorage.setItem(RETURN_KEY, v) : sessionStorage.removeItem(RETURN_KEY); } catch { /* ignore */ } };

function Users({ go, me }: { go: (p: string) => void; me: Me }) {
  const [data, setData] = useState<{ users: UserRow[]; groups: Group[] } | null>(null);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<UserRow | "new" | null>(null);
  const load = useCallback(() => api<{ users: UserRow[]; groups: Group[] }>("/api/admin/users").then(setData).catch(err), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (getReturn() === "new-user") setEdit("new"); }, []);
  const remove = async (u: UserRow) => {
    if (await confirmDialog({ title: tr("Benutzer „{username}“ löschen?", { username: u.username }), message: tr("Das Konto wird gesperrt, der private Bereich bleibt für die Aufbewahrungsfrist verschlossen (auch für dich). Innerhalb der Frist kannst du Benutzer und Bereich zusammen wiederherstellen, danach ist alles endgültig weg."), ok: tr("Löschen"), danger: true })) {
      api(`/api/admin/users/${u.id}`, { method: "DELETE" }).then(load).catch(err);
    }
  };
  const restore = (u: UserRow) => api(`/api/admin/users/${u.id}/restore`, { method: "POST" }).then(load).catch(err);
  const patch = (u: UserRow, body: object) => api(`/api/admin/users/${u.id}`, { method: "PATCH", body }).then(load).catch(err);
  if (!data) return <p className="muted">{tr("Lade …")}</p>;
  const rows = data.users.filter((u) => `${u.username} ${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="admin-toolbar">
        <input type="search" placeholder={tr("Benutzer suchen …")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr("Benutzer suchen")} />
        <span className="spacer" />
        <button className="primary" onClick={() => setEdit("new")}>{tr("+ Neuer Benutzer")}{readDraft() ? tr(" (Entwurf)") : ""}</button>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead><tr><th>{tr("Benutzer")}</th><th>{tr("Gruppen")}</th><th>{tr("Teams")}</th><th title={tr("Datei-Download, Export, OnlyOffice-Download")}>{tr("Download/Export")}</th><th>{tr("Zuletzt")}</th><th /></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={u.is_active ? "" : "inactive"}>
                <td><strong>{u.name || u.username}</strong><small className="muted">{u.username}{u.is_superuser ? tr(" · Superuser") : ""}{u.deleted_at ? tr(" · gelöscht, endgültig am {v}", { v: formatDate(u.purge_at!) }) : !u.is_active ? tr(" · gesperrt") : ""}</small></td>
                <td>{u.groups.map((g) => <span key={g} className="chip">{g}</span>)}</td>
                <td>{u.teams.map((t) => <span key={t.id} className={`chip ${t.leader ? "lead" : ""}`} title={t.leader ? tr("Teamleiter") : t.can_write ? tr("Lesen und Schreiben") : tr("Lesen")}>{t.name}{t.leader ? " ★" : t.can_write ? " ✎" : ""}</span>)}</td>
                <td><label className="switch"><input type="checkbox" checked={u.can_download} onChange={(e) => patch(u, { can_download: e.target.checked })} aria-label={tr("Download für {username}", { username: u.username })} /><span /></label></td>
                <td className="muted">{u.last_login ? formatDate(u.last_login) : "–"}</td>
                <td>{u.deleted_at
                  ? <button onClick={() => restore(u)}>{tr("Wiederherstellen")}</button>
                  : <><button onClick={() => setEdit(u)}>{tr("Bearbeiten")}</button> {u.username !== me.username && <button className="danger" onClick={() => remove(u)}>{tr("Löschen")}</button>}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <UserDialog go={go} user={edit === "new" ? null : edit} groups={data.groups} onClose={() => { setEdit(null); if (getReturn() === "new-user") setReturn(null); }} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

function UserDialog({ user, groups, onClose, onSaved, go }: { go: (p: string) => void; user: UserRow | null; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => (user ? null : readDraft()));
  const [f, setF] = useState({ username: user?.username ?? draft?.f.username ?? "", first_name: user?.first_name ?? draft?.f.first_name ?? "", last_name: user?.last_name ?? draft?.f.last_name ?? "", email: user?.email ?? draft?.f.email ?? "", password: "", is_active: user?.is_active ?? true });
  const [generate, setGenerate] = useState(false);
  const [force, setForce] = useState(user?.must_change_password ?? false);
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const [sel, setSel] = useState<number[]>(() => user ? groups.filter((g) => user.groups.includes(g.name)).map((g) => g.id) : draft?.sel ?? []);
  const adminGroup = groups.find((g) => g.name === "Admin");  // other legacy groups stay as they are; rights come from teams
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [selTeams, setSelTeams] = useState<number[]>(user?.teams.map((t) => t.id) ?? draft?.selTeams ?? []);
  useEffect(() => {
    if (user) return;
    const { password, is_active, ...rest } = f;
    writeDraft(Object.values(rest).some(Boolean) || sel.length || selTeams.length ? { f: rest, sel, selTeams } : null);
  }, [user, f, sel, selTeams]);
  const discard = () => { setDraft(null); setF({ ...f, username: "", first_name: "", last_name: "", email: "", password: "" }); setSel([]); setSelTeams([]); writeDraft(null); };
  useEffect(() => { api<TeamRow[]>("/api/teams").then(setTeams).catch(err); }, []);
  const done = () => { onSaved(); if (getReturn() === "open-team") go("/verwaltung/teams"); };
  const save = async () => {
    try {
      let id = user?.id;
      if (!user) {
        const u = await api<UserRow & { generated_password?: string }>("/api/admin/users", { method: "POST", body: { ...f, password: generate ? undefined : f.password, generate_password: generate, must_change_password: force } });
        id = u.id;
        if (u.generated_password) setShown({ username: u.username, password: u.generated_password });
        if (getReturn() === "new-user") {  // started from "Neues Team": add the new user there and go back
          const td = readTeamDraft() ?? { name: "", members: [] };
          writeTeamDraft({ ...td, members: [...td.members, { user: u.id, username: u.username, name: u.name || u.username, is_leader: !td.members.length, can_write: false }] });
          setReturn("open-team");
        }
        if (sel.length) await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { groups: sel } });
      } else {
        await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { ...f, password: f.password || undefined, groups: sel, must_change_password: force } });
      }
      // Team membership uses the same API as Teams > Mitglieder; the leader role stays there.
      for (const t of teams) {
        const was = t.members.some((m) => m.user === id), now = selTeams.includes(t.id);
        if (was === now) continue;
        const members = now ? [...t.members, { user: id!, is_leader: false, can_write: false }] : t.members.filter((m) => m.user !== id);
        await api(`/api/teams/${t.id}`, { method: "PATCH", body: { members: members.map((m) => ({ user: m.user, is_leader: m.is_leader, can_write: m.can_write })) } });
      }
      writeDraft(null);
      if (generate) return;  // the generated password is shown first (setShown above); "Fertig" finishes
      done();
    } catch (e) { err(e); }
  };
  const field = (k: "username" | "first_name" | "last_name" | "email" | "password", label: string, type = "text") => (
    <label>{label}<input type={type} value={f[k]} disabled={k === "username" && !!user} autoComplete="off"
      onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  if (shown) return (
    <Modal title={tr("Benutzer {username} angelegt", { username: shown.username })} onClose={done}>
      <p>{tr("Das Passwort wird")}{" "}<strong>{tr("nur jetzt einmal")}</strong> {tr("angezeigt und nicht gespeichert. Bitte kopieren und dem Benutzer sicher weitergeben.")}</p>
      <p className="generated-pw"><code>{shown.password}</code> <button type="button" onClick={() => navigator.clipboard?.writeText(shown.password).then(() => notify(tr("Passwort kopiert."), false)).catch(() => notify(tr("Kopieren nicht möglich, bitte markieren.")))}>{tr("Kopieren")}</button></p>
      {force && <p className="muted small">{tr("Der Benutzer muss das Passwort beim ersten Login ändern.")}</p>}
      <div className="actions"><span className="spacer" /><button className="primary" onClick={done}>{tr("Fertig")}</button></div>
    </Modal>
  );
  return (
    <Modal title={user ? tr("Benutzer {username}", { username: user.username }) : tr("Neuer Benutzer")} onClose={onClose}>
      {draft && <p className="draft-note" role="status">{tr("Entwurf wiederhergestellt.")}{" "}<button type="button" onClick={discard}>{tr("Verwerfen")}</button></p>}
      <div className="form-grid">
        {field("username", tr("Benutzername"))}{field("first_name", tr("Vorname"))}{field("last_name", tr("Nachname"))}{field("email", tr("E-Mail"), "email")}
        {!(generate && !user) && field("password", user ? tr("Neues Passwort (leer = unverändert)") : tr("Passwort (mind. 8 Zeichen)"), "password")}
      </div>
      {!user && <label className="check"><input type="checkbox" checked={generate} onChange={(e) => { setGenerate(e.target.checked); setForce(e.target.checked); }} /> {tr("Passwort automatisch generieren (wird einmal angezeigt)")}</label>}
      <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {tr("Muss das Passwort beim nächsten Login ändern")}{user ? tr(" (das Passwort bleibt unverändert)") : ""}</label>
      {adminGroup && (
        <label className="check"><input type="checkbox" checked={sel.includes(adminGroup.id)}
          onChange={(e) => setSel(e.target.checked ? [...sel, adminGroup.id] : sel.filter((x) => x !== adminGroup.id))} /> {tr("Administrator (sieht und darf alles)")}</label>
      )}
      <MultiSelect label={tr("Teams")} placeholder={tr("Teams wählen …")} options={teams.map((t) => ({ id: t.id, name: t.name }))} value={selTeams} onChange={setSelTeams}
        empty={!user && <>{tr("Keine Teams vorhanden.")}{" "}<a href="/verwaltung/teams" onClick={(e) => { e.preventDefault(); (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close(); go("/verwaltung/teams"); }}>{tr("Team anlegen")}</a></>} />
      {user && <label className="check"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> {tr("Konto aktiv")}</label>}
      <div className="actions"><button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>{tr("Abbrechen")}</button><button className="primary" onClick={save}>{tr("Speichern")}</button></div>
    </Modal>
  );
}

// --- Teams -------------------------------------------------------------------------------------------------

interface Member { user: number; username: string; name: string; is_leader: boolean; can_write: boolean }
interface TeamRow { id: number; name: string; area: string | null; trash_days: number; share_by_members: boolean; file_keep_versions: number | null; file_keep_days: number | null; features: Record<string, boolean>; can_manage: boolean; can_lead: boolean; members: Member[] }

function Teams({ me, go }: { me: Me; go: (p: string) => void }) {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [edit, setEdit] = useState<TeamRow | "new" | null>(null);
  useEffect(() => { if (getReturn() === "open-team") { setReturn(null); setEdit("new"); } }, []);
  const [faq, setFaq] = useState(false);
  const load = useCallback(() => api<TeamRow[]>("/api/teams").then(setTeams).catch(err), []);
  useEffect(() => { load(); }, [load]);
  if (!teams) return <p className="muted">{tr("Lade …")}</p>;
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">{tr("Jedes Team hat einen eigenen Wissensbereich, den nur Mitglieder und Admins sehen.")}</p>
        <span className="spacer" />
        {me.is_admin && <button className="primary" onClick={() => setEdit("new")}>{tr("+ Neues Team")}{readTeamDraft() ? tr(" (Entwurf)") : ""}</button>}
      </div>
      <div className="cards">
        {me.is_admin && (
          <article className="card faq-card">
            <header><h2>{tr("FAQ für Anwender")}</h2><span className="vis vis-public">{tr("Öffentlich")}</span></header>
            <p className="muted">{tr("Fester Eintrag, ohne Anmeldung lesbar. Hier legst du fest, wer das FAQ bearbeiten darf, wohin „Ticket erstellen“ führt und wie die FAQ-Ordner vererben.")}</p>
            <button onClick={() => setFaq(true)}>{tr("Bearbeiten")}</button>
          </article>
        )}
        {teams.map((t) => (
          <article key={t.id} className="card">
            <header><h2>{t.name}</h2>{t.area && <a href={`/n/${t.area}`}>{tr("Bereich öffnen →")}</a>}</header>
            <p className="muted">{t.members.length} {tr("Mitglieder · Papierkorb")}{" "}{t.trash_days} {tr("Tage")}</p>
            <ul className="member-list">
              {t.members.map((m) => (
                <li key={m.user}><span className="avatar small">{(m.name || m.username).slice(0, 2).toUpperCase()}</span> {m.name || m.username}
                  <span className={`chip ${m.is_leader ? "lead" : ""}`}>{m.is_leader ? tr("Teamleiter") : m.can_write ? tr("Lesen und Schreiben") : tr("Lesen")}</span></li>
              ))}
            </ul>
            {t.can_lead && <button onClick={() => setEdit(t)}>{tr("Bearbeiten")}</button>}
          </article>
        ))}
        {!teams.length && <p className="muted">{tr("Noch keine Teams.")}</p>}
      </div>
      {faq && <FaqDialog onClose={() => setFaq(false)} onSaved={() => setFaq(false)} />}
      {edit && <TeamDialog go={go} team={edit === "new" ? null : edit} admin={!!me.is_admin} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

const FEATURE_LABELS: Record<string, [string, string]> = {
  wiki: ["Wiki", "Reiter Wiki, Seiten und Dateien der Teambereiche"],
  faq: ["FAQ", "öffentliche FAQ-Bereiche lesen und bearbeiten"],
  tasks: ["Aufgaben", "Reiter Aufgaben und „Meine Aufgaben“ auf der Übersicht"],
  network: ["Netzwerk", "Reiter Netzwerk mit Karten und Netzplänen"],
  export: ["Export", "Download und Export als PDF oder Markdown"],
};

function TeamDialog({ team, admin, onClose, onSaved, go }: { go: (p: string) => void; team: TeamRow | null; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => (team ? null : readTeamDraft()));
  const [name, setName] = useState(team?.name ?? draft?.name ?? "");
  const [days, setDays] = useState(team?.trash_days ?? 40);
  const [shareByMembers, setShareByMembers] = useState(team?.share_by_members ?? false);
  const [keepOn, setKeepOn] = useState(team?.file_keep_versions != null);
  const [keepN, setKeepN] = useState(team?.file_keep_versions ?? 10);
  const [keepDays, setKeepDays] = useState(team?.file_keep_days ?? 365);
  const [members, setMembers] = useState<Member[]>(team?.members ?? draft?.members ?? []);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pick, setPick] = useState("");
  const [tab, setTab] = useState<"members" | "features">("members");
  const [features, setFeatures] = useState<Record<string, boolean>>(team?.features ?? {});
  useEffect(() => { if (admin) api<{ users: UserRow[] }>("/api/admin/users").then((r) => setUsers(r.users)); }, [admin]);
  useEffect(() => { if (!team) writeTeamDraft(name || members.length ? { name, members } : null); }, [team, name, members]);
  const discard = () => { setDraft(null); setName(""); setMembers([]); writeTeamDraft(null); };
  const newUser = () => { setReturn("new-user"); (document.activeElement as HTMLElement)?.closest("dialog")?.close(); go("/verwaltung/benutzer"); };
  const free = users.filter((u) => u.is_active && !members.some((m) => m.user === u.id));
  const set = (id: number, patch: Partial<Member>) => setMembers(members.map((m) => (m.user === id ? { ...m, ...patch } : m)));
  const save = async () => {
    const body: any = { members: members.map((m) => ({ user: m.user, is_leader: m.is_leader, can_write: m.can_write })), trash_days: days,
      file_keep_versions: keepOn ? keepN : null, file_keep_days: keepOn ? keepDays : null };
    try {
      if (!team) await api("/api/teams", { method: "POST", body: { name, members: body.members } });
      else await api(`/api/teams/${team.id}`, { method: "PATCH", body: admin ? { ...body, name, features, share_by_members: shareByMembers } : { members: body.members, trash_days: days, share_by_members: shareByMembers, file_keep_versions: body.file_keep_versions, file_keep_days: body.file_keep_days } });
      writeTeamDraft(null);
      onSaved();
    } catch (e) { err(e); }
  };
  const remove = async () => {
    if (team && await confirmDialog({ title: tr("Team „{name}“ löschen?", { name: team.name }), message: tr("Der Wissensbereich und seine Seiten bleiben erhalten, sind danach aber nur noch für Admins sichtbar."), ok: tr("Löschen"), danger: true })) {
      try { await api(`/api/teams/${team.id}`, { method: "DELETE" }); onSaved(); } catch (e) { err(e); }
    }
  };
  return (
    <Modal title={team ? (/^team\b/i.test(team.name) ? team.name : tr("Team {name}", { name: team.name })) : tr("Neues Team")} onClose={onClose} wide>
      {draft && <p className="draft-note" role="status">{tr("Entwurf wiederhergestellt.")}{" "}<button type="button" onClick={discard}>{tr("Verwerfen")}</button></p>}
      {team && admin && (
        <div className="tabs-inline" role="tablist">
          <button role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")}>{tr("Mitglieder")}</button>
          {admin && <button role="tab" aria-selected={tab === "features"} onClick={() => setTab("features")}>{tr("Funktionen")}</button>}
        </div>
      )}
      {tab === "features" && team && admin ? (
        <fieldset className="feature-list">
          <legend>{tr("Funktionen für dieses Team")}</legend>
          {Object.entries(FEATURE_LABELS).map(([key, [label, hint]]) => (
            <label key={key} className="check-row">
              <input type="checkbox" checked={features[key] !== false} onChange={(e) => setFeatures({ ...features, [key]: e.target.checked })} />
              <span><strong>{tr(label)}</strong><span className="muted"> {tr(hint)}</span></span>
            </label>
          ))}
          <p className="muted">{tr("Aufgaben und Netzwerk sind aus, bis du sie hier für das Team freigibst. Wer in mehreren Teams ist, hat eine Funktion, sobald ein Team sie aktiviert. Admins haben immer alles. „Speichern“ wendet die Auswahl an.")}</p>
          <div className="actions"><span className="spacer" /><button className="primary" onClick={save}>{tr("Speichern")}</button></div>
        </fieldset>
      ) : <>
      <div className="form-grid">
        <label>{tr("Name")}<input value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} /></label>
        {team && <label>{tr("Papierkorb (Tage)")}<input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(+e.target.value)} /></label>}
      </div>
      {team && (
        <fieldset className="share-setting">
          <legend>{tr("Wer darf Ordner dieses Teams an andere Teams freigeben?")}</legend>
          <label className="check-row"><input type="radio" name="share-by" checked={!shareByMembers} onChange={() => setShareByMembers(false)} /> {tr("Nur die Teamleitung")}</label>
          <label className="check-row"><input type="radio" name="share-by" checked={shareByMembers} onChange={() => setShareByMembers(true)} /> {tr("Alle Teammitglieder")}{" "}<span className="muted small">{tr("(Bearbeiten-Rechte vergeben nur Mitglieder mit Schreibrecht)")}</span></label>
        </fieldset>
      )}
      {team && (
        <fieldset className="share-setting file-keep">
          <legend>{tr("Alte Datei-Versionen aufräumen")}</legend>
          <label className="check-row"><input type="radio" name="file-keep" checked={!keepOn} onChange={() => setKeepOn(false)} /> {tr("Alle Versionen behalten")}{" "}<span className="muted small">{tr("(Standard, es wird nichts automatisch gelöscht)")}</span></label>
          <label className="check-row"><input type="radio" name="file-keep" checked={keepOn} onChange={() => setKeepOn(true)} /> {tr("Automatisch aufräumen")}</label>
          {keepOn && (
            <div className="form-grid">
              <label>{tr("Neueste Versionen behalten (N)")}<input type="number" min={1} max={1000} value={keepN} onChange={(e) => setKeepN(+e.target.value)} /></label>
              <label>{tr("Mindestalter in Tagen (X)")}<input type="number" min={1} max={3650} value={keepDays} onChange={(e) => setKeepDays(+e.target.value)} /></label>
            </div>
          )}
          <p className="muted small">{tr("Regel: Eine Datei-Version wird nur gelöscht, wenn sie")}{" "}<strong>{tr("älter als X Tage")}</strong> {tr("ist")}{" "}<strong>{tr("und")}</strong> {tr("nicht mehr zu den")}{" "}<strong>{tr("neuesten N Versionen")}</strong> {tr("ihrer Datei gehört. Beides muss zutreffen; die aktuelle Version bleibt immer. Gilt für Dateien dieses Teams, nicht für Textseiten und deren Versionen. Gelöscht wird einmal täglich.")}</p>
        </fieldset>
      )}
      <table className="admin-table compact">
        <thead><tr><th>{tr("Mitglied")}</th><th>{tr("Teamleiter")}</th><th>{tr("Recht")}</th>{admin && <th />}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user}>
              <td>{m.name || m.username}</td>
              <td><input type="checkbox" checked={m.is_leader} disabled={!admin} aria-label={tr("Teamleiter")} onChange={(e) => set(m.user, { is_leader: e.target.checked, can_write: e.target.checked || m.can_write })} /></td>
              <td><select value={m.is_leader || m.can_write ? "rw" : "r"} disabled={m.is_leader} onChange={(e) => set(m.user, { can_write: e.target.value === "rw" })} aria-label={tr("Recht")}>
                <option value="r">{tr("Lesen")}</option><option value="rw">{tr("Lesen und Schreiben")}</option></select></td>
              {admin && <td><button className="icon-btn" aria-label={tr("Entfernen")} onClick={() => setMembers(members.filter((x) => x.user !== m.user))}>✕</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {admin && (
        <div className="admin-toolbar">
          <select value={pick} onChange={(e) => (e.target.value === "new" ? newUser() : setPick(e.target.value))} aria-label={tr("Mitglied hinzufügen")}>
            <option value="">{tr("Mitglied hinzufügen …")}</option>
            <option value="new">{tr("+ Neuen Benutzer anlegen")}</option>
            {free.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
          </select>
          <button disabled={!pick} onClick={() => { const u = users.find((x) => x.id === +pick)!; setMembers([...members, { user: u.id, username: u.username, name: u.name, is_leader: !members.length, can_write: false }]); setPick(""); }}>{tr("Hinzufügen")}</button>
        </div>
      )}
      <div className="actions">
        {team && admin && <button className="danger" onClick={remove}>{tr("Team löschen")}</button>}
        <span className="spacer" />
        <button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>{tr("Abbrechen")}</button>
        <button className="primary" onClick={save} disabled={!name.trim() || (members.length > 0 && !members.some((m) => m.is_leader))}>{tr("Speichern")}</button>
      </div>
      </>}
    </Modal>
  );
}

// --- Ordnerrechte des FAQ (Teams geben Ordner über das Kontextmenü des Baums frei) ----------------------------------------------------------------

interface Vis { kind: "public" | "login" | "team" | "admin"; badge: string; text: string }
interface FRow { id: string; title: string; depth: number; kind: string; inherit: boolean | null; public: boolean; public_editable: boolean; vis: Vis }
interface FData { rows: FRow[] }

/** FAQ folder tree with Erben and "Ohne Anmeldung". */
function FolderTable() {
  const [rows, setRows] = useState<FRow[] | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const load = useCallback(() => api<FData>("/api/admin/folders?faq=1").then((d) => { setRows(d.rows); setDirty(new Set()); }).catch(err), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <p className="muted">{tr("Lade …")}</p>;
  const upd = (id: string, fn: (r: FRow) => FRow) => { setRows(rows.map((r) => (r.id === id ? fn(r) : r))); setDirty(new Set(dirty).add(id)); };
  const save = async () => {
    try {
      await api("/api/admin/folders/save", { method: "PUT", body: { faq: true, rows: rows.filter((r) => dirty.has(r.id)).map((r) => ({ id: r.id, inherit: r.inherit, public: r.public })) } });
      notify(tr("Rechte gespeichert."), false);
      load();
    } catch (e) { err(e); }
  };
  return (
    <>
      <p className="muted small">{tr("Das FAQ ist ohne Anmeldung sichtbar. Ein Ordner kann „erben“ oder für sich entscheiden, ob er öffentlich ist.")}</p>
      <div className="table-wrap">
        <table className="admin-table rights">
          <thead><tr><th>{tr("Ordner")}</th><th>{tr("Erben")}</th><th>{tr("Ohne Anmeldung sehen")}</th><th>{tr("Wirksam")}</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const locked = r.inherit === true;
              return (
                <tr key={r.id} className={dirty.has(r.id) ? "dirty" : ""}>
                  <td style={{ paddingLeft: 8 + r.depth * 20 }}><span className="folder-name">{r.title}</span></td>
                  <td>{r.inherit === null ? "–" : <input type="checkbox" aria-label={tr("{title}: erben", { title: r.title })} checked={r.inherit} onChange={(e) => upd(r.id, (x) => ({ ...x, inherit: e.target.checked }))} />}</td>
                  <td>{r.public_editable ? <input type="checkbox" aria-label={tr("{title}: ohne Anmeldung", { title: r.title })} checked={r.public} disabled={locked} onChange={(e) => upd(r.id, (x) => ({ ...x, public: e.target.checked }))} /> : <input type="checkbox" checked disabled aria-label={tr("immer öffentlich")} />}</td>
                  <td className="effective"><span className={`vis vis-${r.vis.kind}`}>{trs(r.vis.text)}</span></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={4} className="muted">{tr("Keine Ordner.")}</td></tr>}
          </tbody>
        </table>
      </div>
      <p><button className="primary" onClick={save} disabled={!dirty.size}>{tr("Rechte speichern")}</button></p>
    </>
  );
}

// --- Papierkorb --------------------------------------------------------------------------------------------

interface TrashItem { id: string; title: string; kind: string; team: string | null; team_id: number | null; path: string; deleted_at: string; deleted_by: string | null; purge_at: string; can_purge: boolean }

function Trash() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(() => api<{ items: TrashItem[] }>("/api/trash").then((r) => setItems(r.items)).catch(err), []);
  useEffect(() => { load(); }, [load]);
  if (!items) return <p className="muted">{tr("Lade …")}</p>;
  const restore = (i: TrashItem) => api(`/api/trash/${i.id}/restore`, { method: "POST" }).then(() => { notify(tr("„{title}“ wiederhergestellt.", { title: i.title }), false); load(); }).catch(err);
  const purge = async (i: TrashItem) => {
    if (await confirmDialog({ title: tr("„{title}“ endgültig löschen?", { title: i.title }), message: tr("Das lässt sich nicht rückgängig machen."), ok: tr("Endgültig löschen"), danger: true })) api(`/api/trash/${i.id}`, { method: "DELETE" }).then(load).catch(err);
  };
  return (
    <>
      <p className="muted">{tr("Gelöschtes bleibt im Papierkorb, bis die Frist des Teams (Standard 40 Tage) abgelaufen ist. Danach wird es automatisch endgültig gelöscht.")}</p>
      {items.length === 0 ? <p className="empty">{tr("Der Papierkorb ist leer.")}</p> : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>{tr("Name")}</th><th>{tr("Team")}</th><th>{tr("Gelöscht")}</th><th>{tr("Endgültig am")}</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.title}</strong><small className="muted">{i.kind}{i.path ? ` · ${i.path}` : ""}</small></td>
                  <td>{i.team ?? "–"}</td>
                  <td>{formatDate(i.deleted_at)}<small className="muted">{i.deleted_by}</small></td>
                  <td>{formatDate(i.purge_at)}</td>
                  <td className="row-actions"><button onClick={() => restore(i)}>{tr("Wiederherstellen")}</button>{i.can_purge && <button className="danger" onClick={() => purge(i)}>{tr("Endgültig löschen")}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// --- Protokoll ---------------------------------------------------------------------------------------------

interface AuditData { can_clear?: boolean; total: number; page: number; size: number; teams: { id: number; name: string }[]; actions: string[]; items: { id: number; at: string; username: string; action: string; node: string | null; title: string; team: string | null; details: object; ip: string | null }[] }
const ACTION_LABEL: Record<string, string> = { create: "angelegt", update: "geändert", delete: "gelöscht", move: "verschoben", restore: "wiederhergestellt", publish: "Status", permissions: "Rechte", login: "Anmeldung", login_failed: "Anmeldung fehlgeschlagen", logout: "Abmeldung", login_locked: "Anmeldung gesperrt", team: "Team", user: "Benutzer", audit: "Protokoll" };

function Audit() {
  const [f, setF] = useState({ team: "", user: "", action: "", from: "", to: "", q: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditData | null>(null);
  const query = useMemo(() => new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) }).toString(), [f, page]);
  useEffect(() => { api<AuditData>(`/api/audit?${query}`).then(setData).catch(err); }, [query]);
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1); };
  const clear = async () => {
    if (!(await confirmDialog({ title: tr("Gesamtes Protokoll löschen?"), message: tr("Alle Protokolleinträge werden unwiderruflich gelöscht. Nur ein Eintrag „Protokoll gelöscht“ bleibt übrig."), ok: tr("Weiter"), danger: true }))) return;
    const typed = await ask({ title: tr("Zur Bestätigung tippen"), label: tr("Bitte {phrase} eingeben", { phrase: tr("PROTOKOLL LÖSCHEN") }), ok: tr("Endgültig löschen"), validate: (v) => (v.trim() === tr("PROTOKOLL LÖSCHEN") ? null : tr("Der Text stimmt nicht.")) });
    if (typed === null) return;
    api<{ deleted: number }>("/api/audit", { method: "DELETE", body: { confirm: typed.trim() } })
      .then((r) => { notify(tr("{deleted} Einträge gelöscht.", { deleted: r.deleted }), false); setPage(1); setF({ team: "", user: "", action: "", from: "", to: "", q: "" }); api<AuditData>("/api/audit?page=1").then(setData).catch(err); }).catch(err);
  };
  return (
    <>
      <div className="admin-toolbar filters">
        <label>{tr("Team")}<select value={f.team} onChange={(e) => set("team", e.target.value)}><option value="">{tr("Alle")}</option>{data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="none">{tr("Ohne Team")}</option></select></label>
        <label>{tr("Benutzer")}<input value={f.user} onChange={(e) => set("user", e.target.value)} /></label>
        <label>{tr("Aktion")}<select value={f.action} onChange={(e) => set("action", e.target.value)}><option value="">{tr("Alle")}</option>{data?.actions.map((a) => <option key={a} value={a}>{tr(ACTION_LABEL[a] ?? a)}</option>)}</select></label>
        <label>{tr("Von")}<input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label>{tr("Bis")}<input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
        <label>{tr("Suche")}<input type="search" value={f.q} onChange={(e) => set("q", e.target.value)} /></label>
      </div>
      {!data ? <p className="muted">{tr("Lade …")}</p> : (
        <>
          <div className="table-wrap">
            <table className="admin-table compact">
              <thead><tr><th>{tr("Zeit")}</th><th>{tr("Benutzer")}</th><th>{tr("Aktion")}</th><th>{tr("Objekt")}</th><th>{tr("Team")}</th><th>{tr("IP")}</th></tr></thead>
              <tbody>{data.items.map((a) => (
                <tr key={a.id}><td>{formatDate(a.at)}</td><td>{a.username || "–"}</td><td><span className="chip">{tr(ACTION_LABEL[a.action] ?? a.action)}</span></td>
                  <td>{a.node ? <a href={`/n/${a.node}`}>{a.title}</a> : a.title || "–"}</td><td>{a.team ?? "–"}</td><td className="muted">{a.ip ?? ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="admin-toolbar">
            <span className="muted">{data.total} {tr("Einträge")}</span>{data.can_clear && <button className="danger" onClick={clear}>{tr("Gesamtes Protokoll löschen")}</button>}<span className="spacer" />
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>{tr("← Zurück")}</button>
            <span>{tr("Seite")}{" "}{page} {tr("von")}{" "}{Math.max(1, Math.ceil(data.total / data.size))}</span>
            <button disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>{tr("Weiter →")}</button>
          </div>
        </>
      )}
    </>
  );
}

// --- Info --------------------------------------------------------------------------------------------------

interface InfoData { name: string; version: string; license: string; repository: string; django: string; python: string; changelog: string }
interface Release { version: string; date: string; groups: { title: string; items: string[] }[] }

// The changelog file is Keep-a-Changelog markdown: "## [x.y.z] - date", "### Added|Changed|Fixed", "- item" (items may have `code`).
function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  for (const line of md.split("\n")) {
    const r = line.match(/^## \[([^\]]+)\](?: - (.+))?/);
    if (r) { out.push({ version: r[1], date: r[2] ?? "", groups: [] }); continue; }
    const cur = out[out.length - 1];
    if (!cur) continue;
    const g = line.match(/^### (.+)/);
    if (g) { cur.groups.push({ title: g[1].trim(), items: [] }); continue; }
    const it = line.match(/^- (.+)/);
    if (it && cur.groups.length) cur.groups[cur.groups.length - 1].items.push(it[1]);
    else if (/^\s+\S/.test(line) && cur.groups.length && cur.groups[cur.groups.length - 1].items.length) cur.groups[cur.groups.length - 1].items[cur.groups[cur.groups.length - 1].items.length - 1] += " " + line.trim();
  }
  return out;
}
const inline = (t: string) => t.split(/(`[^`]+`)/).map((p, i) => (p.startsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p));
const GROUP_LABEL: Record<string, string> = { Added: "Neu", Changed: "Geändert", Fixed: "Behoben", Security: "Sicherheit", Removed: "Entfernt" };

function Info() {
  const [d, setD] = useState<InfoData | null>(null);
  useEffect(() => { api<InfoData>("/api/info").then(setD).catch(err); }, []);
  const releases = useMemo(() => (d ? parseChangelog(d.changelog) : []), [d]);
  if (!d) return <p className="muted">{tr("Lade …")}</p>;
  return (
    <>
      <article className="card info-card">
        <h2>{d.name} <span className="chip">v{d.version}</span></h2>
        <dl className="kv">
          <dt>{tr("Version")}</dt><dd>{d.version}</dd>
          <dt>{tr("Lizenz")}</dt><dd>{d.license}</dd>
          <dt>{tr("Projekt")}</dt><dd><a href={d.repository} target="_blank" rel="noopener noreferrer">{d.repository.replace("https://", "")}</a></dd>
          <dt>{tr("Django / Python")}</dt><dd>{d.django} / {d.python}</dd>
        </dl>
      </article>
      <h2>{tr("Changelog")}</h2>
      {!releases.length && <p className="muted">{tr("Kein Changelog vorhanden.")}</p>}
      {releases.map((r) => (
        <article key={r.version} className="card changelog-release">
          <h3>{tr("Version")}{" "}{r.version}{r.date && <small className="muted"> · {r.date}</small>}</h3>
          {r.groups.map((g) => (
            <section key={g.title}>
              <h4>{tr(GROUP_LABEL[g.title] ?? g.title)}</h4>
              <ul>{g.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>
            </section>
          ))}
        </article>
      ))}
    </>
  );
}

// --- System ------------------------------------------------------------------------------------------------

function System() {
  const [d, setD] = useState<any>(null);
  const [integ, setInteg] = useState<{ todoist_allowed: boolean; todoist_links: number } | null>(null);
  const [keep, setKeep] = useState<number | null>(null);
  const [idle, setIdle] = useState<number | null>(null); // minutes, 0 = off; edited in hours
  useEffect(() => { api<{ minutes: number }>("/api/admin/idle-logout").then((r) => setIdle(r.minutes)).catch(err); }, []);
  useEffect(() => { api<{ user_retention_days: number }>("/api/admin/retention").then((r) => setKeep(r.user_retention_days)).catch(err); }, []);
  useEffect(() => { api("/api/admin/system").then(setD).catch(err); api<typeof integ>("/api/admin/integrations").then(setInteg).catch(err); }, []);
  if (!d) return <p className="muted">{tr("Lade …")}</p>;
  const labels: Record<string, string> = { users: tr("Benutzer"), teams: tr("Teams"), nodes: tr("Seiten, Ordner, Dateien"), trashed: tr("im Papierkorb"), files: tr("Dateiversionen"), revisions: tr("Seitenversionen"), audit: tr("Protokolleinträge") };
  return (
    <>
      <div className="stat-grid">
        {Object.entries(d.counts).map(([k, v]) => <div key={k} className="stat"><strong>{v as number}</strong><span>{labels[k] ?? k}</span></div>)}
        <div className="stat"><strong>{formatSize(d.db_bytes)}</strong><span>{tr("Datenbank")}</span></div>
        <div className="stat"><strong>{formatSize(d.files_bytes)}</strong><span>{tr("Dateien")}</span></div>
        {d.disk && <div className="stat"><strong>{formatSize(d.disk.free)}</strong><span>{tr("frei von")}{" "}{formatSize(d.disk.total)}</span></div>}
      </div>
      <dl className="settings">
        <dt>{tr("Django")}</dt><dd>{d.django}</dd><dt>{tr("Python")}</dt><dd>{d.python}</dd><dt>{tr("Papierkorb-Frist (Standard)")}</dt><dd>{d.default_trash_days} {tr("Tage")}</dd>
        <dt>{tr("Serverzeit")}</dt><dd>{formatDate(d.now)}</dd>
      </dl>
      {integ && (
        <fieldset className="feature-list">
          <legend>{tr("Integrationen")}</legend>
          <label className="check-row">
            <input type="checkbox" checked={integ.todoist_allowed} onChange={(e) => api<typeof integ>("/api/admin/integrations", { method: "PUT", body: { todoist_allowed: e.target.checked } }).then(setInteg).catch(err)} />
            <span><strong>{tr("Todoist-Integration erlauben")}</strong><span className="muted"> {tr("Benutzer können ihr Todoist-Konto verbinden (Team-Funktion „Aufgaben“ vorausgesetzt).")}{" "}{integ.todoist_links} {tr("verbunden. Ausgeschaltet ruht der Abgleich für alle.")}</span></span>
          </label>
        </fieldset>
      )}
      {idle !== null && (
        <fieldset className="feature-list">
          <legend>{tr("Anmeldung")}</legend>
          <label className="check-row">
            <input type="number" min={0} max={720} step={0.25} value={idle / 60} style={{ width: "6em" }} onChange={(e) => setIdle(Math.round(Number(e.target.value) * 60))}
              onBlur={() => api<{ minutes: number }>("/api/admin/idle-logout", { method: "PUT", body: { minutes: idle } }).then((r) => { setIdle(r.minutes); notify(tr("Gespeichert."), false); }).catch(err)} />
            <span><strong>{tr("Automatische Abmeldung nach Inaktivität (Stunden)")}</strong><span className="muted"> {tr("Wer so lange nichts tut, wird abgemeldet und sieht danach die Anmeldung; wer aktiv ist, bleibt angemeldet. Standard 4 Stunden,")}{" "}<strong>{tr("0 = nie automatisch abmelden")}</strong>{tr(". Die Einstellung gilt für alle Benutzer.")}</span></span>
          </label>
        </fieldset>
      )}
      {keep !== null && (
        <fieldset className="feature-list">
          <legend>{tr("Gelöschte Benutzer")}</legend>
          <label className="check-row">
            <input type="number" min={1} max={3650} value={keep} style={{ width: "6em" }} onChange={(e) => setKeep(Number(e.target.value))}
              onBlur={() => api<{ user_retention_days: number }>("/api/admin/retention", { method: "PUT", body: { user_retention_days: keep } }).then((r) => setKeep(r.user_retention_days)).catch(err)} />
            <span><strong>{tr("Aufbewahrungsfrist in Tagen")}</strong><span className="muted"> {tr("So lange bleiben ein gelöschter Benutzer und sein privater Bereich erhalten; nur ein Admin kann beides zusammen wiederherstellen. Danach löscht der Timer")}{" "}<code>findus-purge.timer</code> {tr("endgültig.")}</span></span>
          </label>
        </fieldset>
      )}
      <p className="muted">{tr("Papierkorb leeren übernimmt der Timer")}{" "}<code>findus-purge.timer</code>{tr("; Datenbank und Dateien sichert")}{" "}<code>findus-backup.timer</code>{tr("; der Todoist-Abgleich läuft über")}{" "}<code>findus-todoist.timer</code> {tr("alle 5 Minuten.")}</p>
    </>
  );
}


// --- Statistik ---------------------------------------------------------------------------------------------

interface StatsData {
  teams: { id: number; name: string }[];
  users: { id: number; name: string }[];
  counts: { pages: number; faqs: number; files: number; members: number };
  top: { id: string; title: string; views: number }[];
  edited: { id: string; title: string; at: string; user: string }[];
  created: { id: string; title: string; at: string; user: string }[];
  recent: { id: string; title: string; at: string; user: string }[];
  top7: { id: string; title: string; views: number }[];
  top30: { id: string; title: string; views: number }[];
}

function Stats() {
  const [team, setTeam] = useState("");
  const [user, setUser] = useState("");
  const [d, setD] = useState<StatsData | null>(null);
  useEffect(() => {
    const q = new URLSearchParams({ ...(team ? { team } : {}), ...(user ? { user } : {}) }).toString();
    api<StatsData>(`/api/stats${q ? `?${q}` : ""}`).then(setD).catch((e) => { if (user) setUser(""); err(e); });
  }, [team, user]);
  if (!d) return <p className="muted">{tr("Lade …")}</p>;
  const list = (title: string, rows: { id: string; title: string; views?: number; at?: string; user?: string }[]) => (
    <article className="card">
      <h2>{title}</h2>
      {rows.length ? <ol>{rows.map((r) => <li key={r.id}><a href={`/n/${r.id}`}>{r.title}</a> <small>{r.views != null ? `${r.views}×` : `${formatDate(r.at!)} · ${r.user}`}</small></li>)}</ol> : <p className="muted small">{tr("Noch keine Aufrufe.")}</p>}
    </article>
  );
  return (
    <>
      <div className="admin-toolbar">
        <label>{tr("Team")}<select value={team} onChange={(e) => { setTeam(e.target.value); setUser(""); }}><option value="">{tr("Alle")}</option>{d.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label>{tr("Benutzer")}<select value={user} onChange={(e) => setUser(e.target.value)}><option value="">{tr("Alle")}</option>{d.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      </div>
      <div className="stat-grid">
        <div className="stat"><strong>{d.counts.pages}</strong><span>{tr("Seiten")}</span></div>
        <div className="stat"><strong>{d.counts.faqs}</strong><span>{tr("FAQ-Beiträge")}</span></div>
        <div className="stat"><strong>{d.counts.files}</strong><span>{tr("Dateien")}</span></div>
        <div className="stat"><strong>{d.counts.members}</strong><span>{tr("Mitglieder")}</span></div>
      </div>
      <div className="tile-row">
        {list(user ? tr("Meist angesehen (90 Tage)") : tr("Meist angesehen"), d.top)}
        {list(tr("Zuletzt bearbeitet"), d.edited)}
        {list(tr("Zuletzt erstellt"), d.created)}
      </div>
      <div className="tile-row">
        {list(tr("Zuletzt aufgerufen"), d.recent)}
        {list(tr("Meist aufgerufen (7 Tage)"), d.top7)}
        {list(tr("Meist aufgerufen (30 Tage)"), d.top30)}
      </div>
      <p className="muted small">{tr("Einzelne Aufrufe werden 90 Tage aufbewahrt, die Zählerstände pro Seite bleiben.")}</p>
    </>
  );
}

// --- FAQ-Eintrag (Teams) ---------------------------------------------------------------------------------------

interface FaqData { restricted: boolean; users: number[]; teams: number[]; ticket_url: string; ticket_label: string; all_users: { id: number; name: string }[]; all_teams: { id: number; name: string }[] }

function FaqDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [tab, setTab] = useState<"editors" | "folders">("editors");
  const [d, setD] = useState<FaqData | null>(null);
  useEffect(() => { api<FaqData>("/api/admin/faq-editors").then(setD).catch(err); }, []);
  const save = () => d && api("/api/admin/faq-editors", { method: "PUT", body: { users: d.users, teams: d.teams, ticket_url: d.ticket_url, ticket_label: d.ticket_label } })
    .then(() => { notify(tr("FAQ gespeichert."), false); onSaved(); }).catch(err);
  return (
    <Modal title={tr("FAQ für Anwender")} onClose={onClose} wide>
      <div className="tabs-inline" role="tablist">
        <button role="tab" aria-selected={tab === "editors"} onClick={() => setTab("editors")}>{tr("Redaktion und Ticket")}</button>
        <button role="tab" aria-selected={tab === "folders"} onClick={() => setTab("folders")}>{tr("Ordner")}</button>
      </div>
      {tab === "folders" ? <FolderTable /> : !d ? <p className="muted">{tr("Lade …")}</p> : (
        <>
          <p className="muted small">{tr("Das FAQ ist ohne Anmeldung lesbar. Bearbeiten dürfen nur die hier gewählten Personen und Teams. Ist nichts gewählt, gelten die bisherigen Rechte der Bereiche. Die Auswahl wird auch in der API geprüft.")}</p>
          <MultiSelect label={tr("Personen")} placeholder={tr("Personen wählen …")} options={d.all_users} value={d.users} onChange={(users) => setD({ ...d, users })} />
          <MultiSelect label={tr("Ganze Teams (optional)")} placeholder={tr("Teams wählen …")} options={d.all_teams} value={d.teams} onChange={(teams) => setD({ ...d, teams })} />
          <fieldset><legend>{tr("Ticketsystem")}</legend>
            <div className="form-grid">
              <label>{tr("Ticketsystem-Link (nur http/https)")}<input value={d.ticket_url} placeholder="https://tickets.example/neu?subject={q}" onChange={(e) => setD({ ...d, ticket_url: e.target.value })} /></label>
              <label>{tr("Text des Buttons")}<input value={d.ticket_label} onChange={(e) => setD({ ...d, ticket_label: e.target.value })} /></label>
            </div>
            <p className="muted small">{tr("Steht")}{" "}<code>{"{q}"}</code> {tr("in der Adresse, wird der Suchbegriff dort eingesetzt. Ohne Adresse erscheint im Hilfe-Portal und im FAQ kein Ticket-Feld. Nur Administratoren ändern das.")}</p>
          </fieldset>
          <div className="actions"><span className="spacer" /><button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>{tr("Abbrechen")}</button><button className="primary" onClick={save}>{tr("Speichern")}</button></div>
        </>
      )}
    </Modal>
  );
}

/** Dropdown with check boxes and a search field; keeps its state in the parent. */
function MultiSelect({ label, placeholder, options, value, onChange, empty }: { empty?: ReactNode; label: string; placeholder: string; options: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const chosen = options.filter((o) => value.includes(o.id));
  return (
    <div className={`multiselect${open ? " open" : ""}`} ref={box}>
      <span className="ms-label">{label}</span>
      <button type="button" className="ms-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        {chosen.length ? chosen.map((o) => <span key={o.id} className="chip">{o.name}</span>) : <span className="muted">{placeholder}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="ms-pop" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }}>
          <label className="ms-search"><Icon name="search" size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("Suchen …")} aria-label={tr("{label} suchen", { label })} /></label>
          <ul role="listbox" aria-multiselectable="true" aria-label={label}>
            {options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).map((o) => (
              <li key={o.id}><label className="check"><input type="checkbox" checked={value.includes(o.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> {o.name}</label></li>
            ))}
            {!options.length && <li className="muted">{empty || tr("Keine Teams vorhanden.")}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
