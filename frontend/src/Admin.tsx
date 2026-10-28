import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, formatDate, formatSize, Me } from "./api";
import { ask, confirmDialog, notify } from "./Dialog";
import { Icon, IconName } from "./Icons";

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
];
export const adminAllowed = (me: Me) => SECTIONS.some((s) => s.show(me));

const err = (e: unknown) => notify(e instanceof ApiError ? e.message : "Aktion fehlgeschlagen.");

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
      <div className="admin-nav-title">Verwaltung</div>
      {SECTIONS.filter((s) => s.show(me)).map((s) => (
        <a key={s.id} href={`/verwaltung/${s.id}`} aria-current={s.id === current?.id ? "page" : undefined}
          onClick={(e) => { if (e.ctrlKey || e.metaKey || e.button === 1) return; e.preventDefault(); go(`/verwaltung/${s.id}`); }}>
          <Icon name={s.icon} /> {s.label}
        </a>
      ))}
      {me.is_admin && <a href="/admin/" className="admin-nav-ext">Django-Admin <Icon name="external" size={14} /></a>}
    </div>
  );
}

export function Admin({ me, path, go }: { me: Me; path: string; go: (p: string) => void }) {
  const current = sectionOf(me, path);
  if (!current) return <p className="muted">Keine Berechtigung.</p>;
  return (
    <div className="admin-body">
      <h1>{current.label}</h1>
      {current.id === "statistik" && <Stats />}
      {current.id === "benutzer" && <Users go={go} />}
      {current.id === "teams" && <Teams me={me} go={go} />}
      {current.id === "papierkorb" && <Trash />}
      {current.id === "protokoll" && <Audit />}
      {current.id === "system" && <System />}
    </div>
  );
}

// --- Benutzer ----------------------------------------------------------------------------------------------

interface UserRow {
  id: number; username: string; name: string; first_name: string; last_name: string; email: string; is_active: boolean;
  is_superuser: boolean; groups: string[]; teams: { id: number; name: string; leader: boolean; can_write: boolean }[];
  can_download: boolean; last_login: string | null;
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

function Users({ go }: { go: (p: string) => void }) {
  const [data, setData] = useState<{ users: UserRow[]; groups: Group[] } | null>(null);
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<UserRow | "new" | null>(null);
  const load = useCallback(() => api<{ users: UserRow[]; groups: Group[] }>("/api/admin/users").then(setData).catch(err), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (getReturn() === "new-user") setEdit("new"); }, []);
  const patch = (u: UserRow, body: object) => api(`/api/admin/users/${u.id}`, { method: "PATCH", body }).then(load).catch(err);
  if (!data) return <p className="muted">Lade …</p>;
  const rows = data.users.filter((u) => `${u.username} ${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="admin-toolbar">
        <input type="search" placeholder="Benutzer suchen …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Benutzer suchen" />
        <span className="spacer" />
        <button className="primary" onClick={() => setEdit("new")}>+ Neuer Benutzer{readDraft() ? " (Entwurf)" : ""}</button>
      </div>
      <div className="table-wrap">
        <table className="admin-table">
          <thead><tr><th>Benutzer</th><th>Gruppen</th><th>Teams</th><th title="Datei-Download, Export, OnlyOffice-Download">Download/Export</th><th>Zuletzt</th><th /></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className={u.is_active ? "" : "inactive"}>
                <td><strong>{u.name || u.username}</strong><small className="muted">{u.username}{u.is_superuser ? " · Superuser" : ""}{!u.is_active ? " · gesperrt" : ""}</small></td>
                <td>{u.groups.map((g) => <span key={g} className="chip">{g}</span>)}</td>
                <td>{u.teams.map((t) => <span key={t.id} className={`chip ${t.leader ? "lead" : ""}`} title={t.leader ? "Teamleiter" : t.can_write ? "Lesen und Schreiben" : "Lesen"}>{t.name}{t.leader ? " ★" : t.can_write ? " ✎" : ""}</span>)}</td>
                <td><label className="switch"><input type="checkbox" checked={u.can_download} onChange={(e) => patch(u, { can_download: e.target.checked })} aria-label={`Download für ${u.username}`} /><span /></label></td>
                <td className="muted">{u.last_login ? formatDate(u.last_login) : "–"}</td>
                <td><button onClick={() => setEdit(u)}>Bearbeiten</button></td>
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
  const save = async () => {
    try {
      let id = user?.id;
      if (!user) {
        const u = await api<UserRow>("/api/admin/users", { method: "POST", body: f });
        id = u.id;
        if (getReturn() === "new-user") {  // started from "Neues Team": add the new user there and go back
          const td = readTeamDraft() ?? { name: "", members: [] };
          writeTeamDraft({ ...td, members: [...td.members, { user: u.id, username: u.username, name: u.name || u.username, is_leader: !td.members.length, can_write: false }] });
          setReturn("open-team");
        }
        if (sel.length) await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { groups: sel } });
      } else {
        await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: { ...f, password: f.password || undefined, groups: sel } });
      }
      // Team membership uses the same API as Teams > Mitglieder; the leader role stays there.
      for (const t of teams) {
        const was = t.members.some((m) => m.user === id), now = selTeams.includes(t.id);
        if (was === now) continue;
        const members = now ? [...t.members, { user: id!, is_leader: false, can_write: false }] : t.members.filter((m) => m.user !== id);
        await api(`/api/teams/${t.id}`, { method: "PATCH", body: { members: members.map((m) => ({ user: m.user, is_leader: m.is_leader, can_write: m.can_write })) } });
      }
      writeDraft(null);
      onSaved();
      if (getReturn() === "open-team") go("/verwaltung/teams");
    } catch (e) { err(e); }
  };
  const field = (k: "username" | "first_name" | "last_name" | "email" | "password", label: string, type = "text") => (
    <label>{label}<input type={type} value={f[k]} disabled={k === "username" && !!user} autoComplete="off"
      onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>
  );
  return (
    <Modal title={user ? `Benutzer ${user.username}` : "Neuer Benutzer"} onClose={onClose}>
      {draft && <p className="draft-note" role="status">Entwurf wiederhergestellt. <button type="button" onClick={discard}>Verwerfen</button></p>}
      <div className="form-grid">
        {field("username", "Benutzername")}{field("first_name", "Vorname")}{field("last_name", "Nachname")}{field("email", "E-Mail", "email")}
        {field("password", user ? "Neues Passwort (leer = unverändert)" : "Passwort (mind. 8 Zeichen)", "password")}
      </div>
      {adminGroup && (
        <label className="check"><input type="checkbox" checked={sel.includes(adminGroup.id)}
          onChange={(e) => setSel(e.target.checked ? [...sel, adminGroup.id] : sel.filter((x) => x !== adminGroup.id))} /> Administrator (sieht und darf alles)</label>
      )}
      <MultiSelect label="Teams" placeholder="Teams wählen …" options={teams.map((t) => ({ id: t.id, name: t.name }))} value={selTeams} onChange={setSelTeams}
        empty={!user && <>Keine Teams vorhanden. <a href="/verwaltung/teams" onClick={(e) => { e.preventDefault(); (e.currentTarget.closest("dialog") as HTMLDialogElement | null)?.close(); go("/verwaltung/teams"); }}>Team anlegen</a></>} />
      {user && <label className="check"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Konto aktiv</label>}
      <div className="actions"><button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></div>
    </Modal>
  );
}

// --- Teams -------------------------------------------------------------------------------------------------

interface Member { user: number; username: string; name: string; is_leader: boolean; can_write: boolean }
interface TeamRow { id: number; name: string; area: string | null; trash_days: number; can_manage: boolean; can_lead: boolean; members: Member[] }

function Teams({ me, go }: { me: Me; go: (p: string) => void }) {
  const [teams, setTeams] = useState<TeamRow[] | null>(null);
  const [edit, setEdit] = useState<TeamRow | "new" | null>(null);
  useEffect(() => { if (getReturn() === "open-team") { setReturn(null); setEdit("new"); } }, []);
  const [faq, setFaq] = useState(false);
  const load = useCallback(() => api<TeamRow[]>("/api/teams").then(setTeams).catch(err), []);
  useEffect(() => { load(); }, [load]);
  if (!teams) return <p className="muted">Lade …</p>;
  return (
    <>
      <div className="admin-toolbar">
        <p className="muted">Jedes Team hat einen eigenen Wissensbereich, den nur Mitglieder und Admins sehen.</p>
        <span className="spacer" />
        {me.is_admin && <button className="primary" onClick={() => setEdit("new")}>+ Neues Team{readTeamDraft() ? " (Entwurf)" : ""}</button>}
      </div>
      <div className="cards">
        {me.is_admin && (
          <article className="card faq-card">
            <header><h2>FAQ für Anwender</h2><span className="vis vis-public">Öffentlich</span></header>
            <p className="muted">Fester Eintrag, ohne Anmeldung lesbar. Hier legst du fest, wer das FAQ bearbeiten darf, wohin „Ticket erstellen“ führt und wie die FAQ-Ordner vererben.</p>
            <button onClick={() => setFaq(true)}>Bearbeiten</button>
          </article>
        )}
        {teams.map((t) => (
          <article key={t.id} className="card">
            <header><h2>{t.name}</h2>{t.area && <a href={`/n/${t.area}`}>Bereich öffnen →</a>}</header>
            <p className="muted">{t.members.length} Mitglieder · Papierkorb {t.trash_days} Tage</p>
            <ul className="member-list">
              {t.members.map((m) => (
                <li key={m.user}><span className="avatar small">{(m.name || m.username).slice(0, 2).toUpperCase()}</span> {m.name || m.username}
                  <span className={`chip ${m.is_leader ? "lead" : ""}`}>{m.is_leader ? "Teamleiter" : m.can_write ? "Lesen und Schreiben" : "Lesen"}</span></li>
              ))}
            </ul>
            {t.can_lead && <button onClick={() => setEdit(t)}>Bearbeiten</button>}
          </article>
        ))}
        {!teams.length && <p className="muted">Noch keine Teams.</p>}
      </div>
      {faq && <FaqDialog onClose={() => setFaq(false)} onSaved={() => setFaq(false)} />}
      {edit && <TeamDialog go={go} team={edit === "new" ? null : edit} admin={!!me.is_admin} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

function TeamDialog({ team, admin, onClose, onSaved, go }: { go: (p: string) => void; team: TeamRow | null; admin: boolean; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => (team ? null : readTeamDraft()));
  const [name, setName] = useState(team?.name ?? draft?.name ?? "");
  const [days, setDays] = useState(team?.trash_days ?? 40);
  const [members, setMembers] = useState<Member[]>(team?.members ?? draft?.members ?? []);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pick, setPick] = useState("");
  const [tab, setTab] = useState<"members" | "folders">("members");
  useEffect(() => { if (admin) api<{ users: UserRow[] }>("/api/admin/users").then((r) => setUsers(r.users)); }, [admin]);
  useEffect(() => { if (!team) writeTeamDraft(name || members.length ? { name, members } : null); }, [team, name, members]);
  const discard = () => { setDraft(null); setName(""); setMembers([]); writeTeamDraft(null); };
  const newUser = () => { setReturn("new-user"); (document.activeElement as HTMLElement)?.closest("dialog")?.close(); go("/verwaltung/benutzer"); };
  const free = users.filter((u) => u.is_active && !members.some((m) => m.user === u.id));
  const set = (id: number, patch: Partial<Member>) => setMembers(members.map((m) => (m.user === id ? { ...m, ...patch } : m)));
  const save = async () => {
    const body: any = { members: members.map((m) => ({ user: m.user, is_leader: m.is_leader, can_write: m.can_write })), trash_days: days };
    try {
      if (!team) await api("/api/teams", { method: "POST", body: { name, members: body.members } });
      else await api(`/api/teams/${team.id}`, { method: "PATCH", body: admin ? { ...body, name } : { members: body.members, trash_days: days } });
      writeTeamDraft(null);
      onSaved();
    } catch (e) { err(e); }
  };
  const remove = async () => {
    if (team && await confirmDialog({ title: `Team „${team.name}“ löschen?`, message: "Der Wissensbereich und seine Seiten bleiben erhalten, sind danach aber nur noch für Admins sichtbar.", ok: "Löschen", danger: true })) {
      try { await api(`/api/teams/${team.id}`, { method: "DELETE" }); onSaved(); } catch (e) { err(e); }
    }
  };
  return (
    <Modal title={team ? `Team ${team.name}` : "Neues Team"} onClose={onClose} wide>
      {draft && <p className="draft-note" role="status">Entwurf wiederhergestellt. <button type="button" onClick={discard}>Verwerfen</button></p>}
      {team && (
        <div className="tabs-inline" role="tablist">
          <button role="tab" aria-selected={tab === "members"} onClick={() => setTab("members")}>Mitglieder</button>
          <button role="tab" aria-selected={tab === "folders"} onClick={() => setTab("folders")}>Ordner</button>
        </div>
      )}
      {tab === "folders" && team ? <FolderTable mode="team" team={team.id} /> : <>
      <div className="form-grid">
        <label>Name<input value={name} disabled={!admin} onChange={(e) => setName(e.target.value)} /></label>
        {team && <label>Papierkorb (Tage)<input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(+e.target.value)} /></label>}
      </div>
      <table className="admin-table compact">
        <thead><tr><th>Mitglied</th><th>Teamleiter</th><th>Recht</th>{admin && <th />}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user}>
              <td>{m.name || m.username}</td>
              <td><input type="checkbox" checked={m.is_leader} disabled={!admin} aria-label="Teamleiter" onChange={(e) => set(m.user, { is_leader: e.target.checked, can_write: e.target.checked || m.can_write })} /></td>
              <td><select value={m.is_leader || m.can_write ? "rw" : "r"} disabled={m.is_leader} onChange={(e) => set(m.user, { can_write: e.target.value === "rw" })} aria-label="Recht">
                <option value="r">Lesen</option><option value="rw">Lesen und Schreiben</option></select></td>
              {admin && <td><button className="icon-btn" aria-label="Entfernen" onClick={() => setMembers(members.filter((x) => x.user !== m.user))}>✕</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
      {admin && (
        <div className="admin-toolbar">
          <select value={pick} onChange={(e) => (e.target.value === "new" ? newUser() : setPick(e.target.value))} aria-label="Mitglied hinzufügen">
            <option value="">Mitglied hinzufügen …</option>
            <option value="new">+ Neuen Benutzer anlegen</option>
            {free.map((u) => <option key={u.id} value={u.id}>{u.name || u.username}</option>)}
          </select>
          <button disabled={!pick} onClick={() => { const u = users.find((x) => x.id === +pick)!; setMembers([...members, { user: u.id, username: u.username, name: u.name, is_leader: !members.length, can_write: false }]); setPick(""); }}>Hinzufügen</button>
        </div>
      )}
      <div className="actions">
        {team && admin && <button className="danger" onClick={remove}>Team löschen</button>}
        <span className="spacer" />
        <button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>Abbrechen</button>
        <button className="primary" onClick={save} disabled={!name.trim() || !members.some((m) => m.is_leader)}>Speichern</button>
      </div>
      </>}
    </Modal>
  );
}

// --- Ordnerrechte (im Team bzw. im FAQ-Eintrag) ----------------------------------------------------------------

interface Vis { kind: "public" | "login" | "team" | "admin"; badge: string; text: string }
interface FRow { id: string; title: string; depth: number; kind: string; inherit: boolean | null; public: boolean; public_editable: boolean; vis: Vis; cells: Record<string, { see: boolean; edit: boolean }> }
interface FData { principals: { key: string; label: string; team: number | null }[]; rows: FRow[] }

/** Folder tree with Erben, Sehen/Bearbeiten for one team (mode "team") or Erben and "Ohne Anmeldung" for the FAQ (mode "faq"). */
function FolderTable({ mode, team }: { mode: "team" | "faq"; team?: number }) {
  const q = mode === "faq" ? "faq=1" : `team=${team}`;
  const [data, setData] = useState<FData | null>(null);
  const [rows, setRows] = useState<FRow[]>([]);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const load = useCallback(() => api<FData>(`/api/admin/folders?${q}`).then((d) => { setData(d); setRows(d.rows); setDirty(new Set()); }).catch(err), [q]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="muted">Lade …</p>;
  const key = data.principals[0]?.key;
  const upd = (id: string, fn: (r: FRow) => FRow) => { setRows(rows.map((r) => (r.id === id ? fn(r) : r))); setDirty(new Set(dirty).add(id)); };
  const setCell = (r: FRow, k: "see" | "edit", v: boolean) => upd(r.id, (x) => {
    const c = { ...x.cells[key], [k]: v };
    if (k === "edit" && v) c.see = true;
    if (k === "see" && !v) c.edit = false;
    return { ...x, cells: { ...x.cells, [key]: c } };
  });
  const save = async () => {
    try {
      await api("/api/admin/folders/save", { method: "PUT", body: { ...(mode === "faq" ? { faq: true } : { team }), rows: rows.filter((r) => dirty.has(r.id)).map((r) => ({ id: r.id, inherit: r.inherit, public: r.public, cells: r.cells })) } });
      notify("Rechte gespeichert.", false);
      load();
    } catch (e) { err(e); }
  };
  return (
    <>
      <p className="muted small">{mode === "faq"
        ? "Das FAQ ist ohne Anmeldung sichtbar. Ein Ordner kann „erben“ oder für sich entscheiden, ob er öffentlich ist."
        : "Pro Ordner legst du fest, ob dieses Team ihn sehen und bearbeiten darf. „Erben“ übernimmt die Rechte des übergeordneten Ordners; wird es abgewählt, bleiben die bisherigen Rechte aller Gruppen zunächst erhalten. Administratoren sehen immer alles."}</p>
      <div className="table-wrap">
        <table className="admin-table rights">
          <thead><tr><th>Ordner</th><th>Erben</th>{mode === "faq" && <th>Ohne Anmeldung sehen</th>}{mode === "team" && <><th>Sehen</th><th>Bearbeiten</th></>}<th>Wirksam</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const locked = r.inherit === true;
              const c = r.cells[key] ?? { see: false, edit: false };
              return (
                <tr key={r.id} className={dirty.has(r.id) ? "dirty" : ""}>
                  <td style={{ paddingLeft: 8 + r.depth * 20 }}><span className="folder-name">{r.title}</span></td>
                  <td>{r.inherit === null ? "–" : <input type="checkbox" aria-label={`${r.title}: erben`} checked={r.inherit} onChange={(e) => upd(r.id, (x) => ({ ...x, inherit: e.target.checked }))} />}</td>
                  {mode === "faq" && <td>{r.public_editable ? <input type="checkbox" aria-label={`${r.title}: ohne Anmeldung`} checked={r.public} disabled={locked} onChange={(e) => upd(r.id, (x) => ({ ...x, public: e.target.checked }))} /> : <input type="checkbox" checked disabled aria-label="immer öffentlich" />}</td>}
                  {mode === "team" && <>
                    <td><input type="checkbox" aria-label={`${r.title}: sehen`} checked={c.see} disabled={locked} onChange={(e) => setCell(r, "see", e.target.checked)} /></td>
                    <td><input type="checkbox" aria-label={`${r.title}: bearbeiten`} checked={c.edit} disabled={locked} onChange={(e) => setCell(r, "edit", e.target.checked)} /></td>
                  </>}
                  <td className="effective"><span className={`vis vis-${r.vis.kind}`}>{r.vis.text}</span></td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={5} className="muted">Keine Ordner.</td></tr>}
          </tbody>
        </table>
      </div>
      <p><button className="primary" onClick={save} disabled={!dirty.size}>Rechte speichern</button></p>
    </>
  );
}

// --- Papierkorb --------------------------------------------------------------------------------------------

interface TrashItem { id: string; title: string; kind: string; team: string | null; team_id: number | null; path: string; deleted_at: string; deleted_by: string | null; purge_at: string; can_purge: boolean }

function Trash() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const load = useCallback(() => api<{ items: TrashItem[] }>("/api/trash").then((r) => setItems(r.items)).catch(err), []);
  useEffect(() => { load(); }, [load]);
  if (!items) return <p className="muted">Lade …</p>;
  const restore = (i: TrashItem) => api(`/api/trash/${i.id}/restore`, { method: "POST" }).then(() => { notify(`„${i.title}“ wiederhergestellt.`, false); load(); }).catch(err);
  const purge = async (i: TrashItem) => {
    if (await confirmDialog({ title: `„${i.title}“ endgültig löschen?`, message: "Das lässt sich nicht rückgängig machen.", ok: "Endgültig löschen", danger: true })) api(`/api/trash/${i.id}`, { method: "DELETE" }).then(load).catch(err);
  };
  return (
    <>
      <p className="muted">Gelöschtes bleibt im Papierkorb, bis die Frist des Teams (Standard 40 Tage) abgelaufen ist. Danach wird es automatisch endgültig gelöscht.</p>
      {items.length === 0 ? <p className="empty">Der Papierkorb ist leer.</p> : (
        <div className="table-wrap">
          <table className="admin-table">
            <thead><tr><th>Name</th><th>Team</th><th>Gelöscht</th><th>Endgültig am</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.title}</strong><small className="muted">{i.kind}{i.path ? ` · ${i.path}` : ""}</small></td>
                  <td>{i.team ?? "–"}</td>
                  <td>{formatDate(i.deleted_at)}<small className="muted">{i.deleted_by}</small></td>
                  <td>{formatDate(i.purge_at)}</td>
                  <td className="row-actions"><button onClick={() => restore(i)}>Wiederherstellen</button>{i.can_purge && <button className="danger" onClick={() => purge(i)}>Endgültig löschen</button>}</td>
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

interface AuditData { total: number; page: number; size: number; teams: { id: number; name: string }[]; actions: string[]; items: { id: number; at: string; username: string; action: string; node: string | null; title: string; team: string | null; details: object; ip: string | null }[] }
const ACTION_LABEL: Record<string, string> = { create: "angelegt", update: "geändert", delete: "gelöscht", move: "verschoben", restore: "wiederhergestellt", publish: "Status", permissions: "Rechte", login: "Anmeldung", login_failed: "Anmeldung fehlgeschlagen", logout: "Abmeldung", team: "Team", user: "Benutzer" };

function Audit() {
  const [f, setF] = useState({ team: "", user: "", action: "", from: "", to: "", q: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditData | null>(null);
  const query = useMemo(() => new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) }).toString(), [f, page]);
  useEffect(() => { api<AuditData>(`/api/audit?${query}`).then(setData).catch(err); }, [query]);
  const set = (k: keyof typeof f, v: string) => { setF({ ...f, [k]: v }); setPage(1); };
  return (
    <>
      <div className="admin-toolbar filters">
        <label>Team<select value={f.team} onChange={(e) => set("team", e.target.value)}><option value="">Alle</option>{data?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="none">Ohne Team</option></select></label>
        <label>Benutzer<input value={f.user} onChange={(e) => set("user", e.target.value)} /></label>
        <label>Aktion<select value={f.action} onChange={(e) => set("action", e.target.value)}><option value="">Alle</option>{data?.actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}</select></label>
        <label>Von<input type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></label>
        <label>Bis<input type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></label>
        <label>Suche<input type="search" value={f.q} onChange={(e) => set("q", e.target.value)} /></label>
      </div>
      {!data ? <p className="muted">Lade …</p> : (
        <>
          <div className="table-wrap">
            <table className="admin-table compact">
              <thead><tr><th>Zeit</th><th>Benutzer</th><th>Aktion</th><th>Objekt</th><th>Team</th><th>IP</th></tr></thead>
              <tbody>{data.items.map((a) => (
                <tr key={a.id}><td>{formatDate(a.at)}</td><td>{a.username || "–"}</td><td><span className="chip">{ACTION_LABEL[a.action] ?? a.action}</span></td>
                  <td>{a.node ? <a href={`/n/${a.node}`}>{a.title}</a> : a.title || "–"}</td><td>{a.team ?? "–"}</td><td className="muted">{a.ip ?? ""}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className="admin-toolbar">
            <span className="muted">{data.total} Einträge</span><span className="spacer" />
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>← Zurück</button>
            <span>Seite {page} von {Math.max(1, Math.ceil(data.total / data.size))}</span>
            <button disabled={page * data.size >= data.total} onClick={() => setPage(page + 1)}>Weiter →</button>
          </div>
        </>
      )}
    </>
  );
}

// --- System ------------------------------------------------------------------------------------------------

function System() {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api("/api/admin/system").then(setD).catch(err); }, []);
  if (!d) return <p className="muted">Lade …</p>;
  const labels: Record<string, string> = { users: "Benutzer", teams: "Teams", nodes: "Seiten, Ordner, Dateien", trashed: "im Papierkorb", files: "Dateiversionen", revisions: "Seitenversionen", audit: "Protokolleinträge" };
  return (
    <>
      <div className="stat-grid">
        {Object.entries(d.counts).map(([k, v]) => <div key={k} className="stat"><strong>{v as number}</strong><span>{labels[k] ?? k}</span></div>)}
        <div className="stat"><strong>{formatSize(d.db_bytes)}</strong><span>Datenbank</span></div>
        <div className="stat"><strong>{formatSize(d.files_bytes)}</strong><span>Dateien</span></div>
        {d.disk && <div className="stat"><strong>{formatSize(d.disk.free)}</strong><span>frei von {formatSize(d.disk.total)}</span></div>}
      </div>
      <dl className="settings">
        <dt>Django</dt><dd>{d.django}</dd><dt>Python</dt><dd>{d.python}</dd><dt>Papierkorb-Frist (Standard)</dt><dd>{d.default_trash_days} Tage</dd>
        <dt>Serverzeit</dt><dd>{formatDate(d.now)}</dd>
      </dl>
      <p className="muted">Papierkorb leeren übernimmt der Timer <code>findus-purge.timer</code>; Datenbank und Dateien sichert <code>findus-backup.timer</code>.</p>
    </>
  );
}


// --- Statistik ---------------------------------------------------------------------------------------------

interface StatsData {
  teams: { id: number; name: string }[];
  counts: { pages: number; faqs: number; files: number; members: number };
  recent: { id: string; title: string; at: string; user: string }[];
  top7: { id: string; title: string; views: number }[];
  top30: { id: string; title: string; views: number }[];
}

function Stats() {
  const [team, setTeam] = useState("");
  const [d, setD] = useState<StatsData | null>(null);
  useEffect(() => { api<StatsData>(`/api/stats${team ? `?team=${team}` : ""}`).then(setD).catch(err); }, [team]);
  if (!d) return <p className="muted">Lade …</p>;
  const list = (title: string, rows: { id: string; title: string; views?: number; at?: string; user?: string }[]) => (
    <article className="card">
      <h2>{title}</h2>
      {rows.length ? <ol>{rows.map((r) => <li key={r.id}><a href={`/n/${r.id}`}>{r.title}</a> <small>{r.views != null ? `${r.views}×` : `${formatDate(r.at!)} · ${r.user}`}</small></li>)}</ol> : <p className="muted small">Noch keine Aufrufe.</p>}
    </article>
  );
  return (
    <>
      <div className="admin-toolbar">
        <label>Team<select value={team} onChange={(e) => setTeam(e.target.value)}><option value="">{d.teams.length > 1 || true ? "Alle" : ""}</option>{d.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      </div>
      <div className="stat-grid">
        <div className="stat"><strong>{d.counts.pages}</strong><span>Seiten</span></div>
        <div className="stat"><strong>{d.counts.faqs}</strong><span>FAQ-Beiträge</span></div>
        <div className="stat"><strong>{d.counts.files}</strong><span>Dateien</span></div>
        <div className="stat"><strong>{d.counts.members}</strong><span>Mitglieder</span></div>
      </div>
      <div className="tile-row">
        {list("Zuletzt aufgerufen", d.recent)}
        {list("Meist aufgerufen (7 Tage)", d.top7)}
        {list("Meist aufgerufen (30 Tage)", d.top30)}
      </div>
      <p className="muted small">Einzelne Aufrufe werden 90 Tage aufbewahrt, die Zählerstände pro Seite bleiben.</p>
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
    .then(() => { notify("FAQ gespeichert.", false); onSaved(); }).catch(err);
  return (
    <Modal title="FAQ für Anwender" onClose={onClose} wide>
      <div className="tabs-inline" role="tablist">
        <button role="tab" aria-selected={tab === "editors"} onClick={() => setTab("editors")}>Redaktion und Ticket</button>
        <button role="tab" aria-selected={tab === "folders"} onClick={() => setTab("folders")}>Ordner</button>
      </div>
      {tab === "folders" ? <FolderTable mode="faq" /> : !d ? <p className="muted">Lade …</p> : (
        <>
          <p className="muted small">Das FAQ ist ohne Anmeldung lesbar. Bearbeiten dürfen nur die hier gewählten Personen und Teams. Ist nichts gewählt, gelten die bisherigen Rechte der Bereiche. Die Auswahl wird auch in der API geprüft.</p>
          <MultiSelect label="Personen" placeholder="Personen wählen …" options={d.all_users} value={d.users} onChange={(users) => setD({ ...d, users })} />
          <MultiSelect label="Ganze Teams (optional)" placeholder="Teams wählen …" options={d.all_teams} value={d.teams} onChange={(teams) => setD({ ...d, teams })} />
          <fieldset><legend>Ticketsystem</legend>
            <div className="form-grid">
              <label>Ziel-Adresse (nur http/https)<input value={d.ticket_url} placeholder="https://tickets.example/neu?subject={q}" onChange={(e) => setD({ ...d, ticket_url: e.target.value })} /></label>
              <label>Text des Buttons<input value={d.ticket_label} onChange={(e) => setD({ ...d, ticket_label: e.target.value })} /></label>
            </div>
            <p className="muted small">Steht <code>{"{q}"}</code> in der Adresse, wird der Suchbegriff dort eingesetzt. Ohne Adresse erscheint kein Ticket-Hinweis im FAQ.</p>
          </fieldset>
          <div className="actions"><span className="spacer" /><button onClick={() => (document.activeElement as HTMLElement)?.closest("dialog")?.close()}>Abbrechen</button><button className="primary" onClick={save}>Speichern</button></div>
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
          <label className="ms-search"><Icon name="search" size={14} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suchen …" aria-label={`${label} suchen`} /></label>
          <ul role="listbox" aria-multiselectable="true" aria-label={label}>
            {options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).map((o) => (
              <li key={o.id}><label className="check"><input type="checkbox" checked={value.includes(o.id)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> {o.name}</label></li>
            ))}
            {!options.length && <li className="muted">{empty || "Keine Teams vorhanden."}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
