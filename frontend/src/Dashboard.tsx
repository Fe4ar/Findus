import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, formatDate } from "./api";
import { Icon as LineIcon } from "./Icons";
import { ask, confirmDialog, notify } from "./Dialog";

// Personal dashboard: global shortcuts (admins), one category per team (leaders) and the user's own categories.
// Own categories and shortcuts can be reordered and moved by drag & drop; the order is stored per user.

interface Shortcut { id: number; name: string; url: string; icon: string; description: string; online: boolean | null }
interface Category { id: number; name: string; kind: "global" | "team" | "user"; team: string | null; team_id: number | null; editable: boolean; shortcuts: Shortcut[] }
interface Data { categories: Category[]; teams: { id: number; name: string }[]; is_admin: boolean }

const ICONS = ["🔗", "🖥️", "🗄️", "📡", "🔀", "🛡️", "🔁", "🏠", "💡", "🎬", "🎵", "📷", "🖨️", "☁️", "📦", "🔧", "📊", "🎮", "📧", "📁"];
const err = (e: unknown) => notify(e instanceof ApiError ? e.message : "Aktion fehlgeschlagen.");

function Icon({ s }: { s: Pick<Shortcut, "icon" | "url"> }) {
  if (s.icon === "favicon") {
    let origin = "";
    try { origin = new URL(s.url).origin; } catch { /* tcp:// has no favicon */ }
    // The browser fetches the favicon straight from the service itself; nothing goes to a third party.
    return origin ? <img className="tile-icon" src={`${origin}/favicon.ico`} alt="" width={24} height={24} /> : <span className="tile-icon" aria-hidden="true">🔗</span>;
  }
  return <span className="tile-icon" aria-hidden="true">{s.icon}</span>;
}

export function Dashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ cat: Category; sc?: Shortcut } | null>(null);
  const drag = useRef<{ sc?: Shortcut; cat?: Category } | null>(null);
  const load = useCallback(() => api<Data>("/api/dashboard").then(setData).catch(() => setError("Dienste konnten nicht geladen werden.")), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">Dienste werden geprüft …</p>;

  const run = (p: Promise<unknown>) => p.then(load).catch(err);
  const saveOrder = (cats: Category[]) => {
    setData({ ...data, categories: cats });
    api("/api/dashboard/order", { method: "PUT", body: { categories: cats.filter((c) => c.editable).map((c) => c.id), shortcuts: Object.fromEntries(cats.filter((c) => c.editable).map((c) => [c.id, c.shortcuts.map((s) => s.id)])) } }).catch(err);
  };
  const moveShortcut = (sc: Shortcut, to: Category, before?: Shortcut) => {
    const from = data.categories.find((c) => c.shortcuts.some((s) => s.id === sc.id))!;
    if (from.kind !== to.kind || from.team_id !== to.team_id) return;
    const cats = data.categories.map((c) => {
      let list = c.shortcuts.filter((s) => s.id !== sc.id);
      if (c.id === to.id) { const i = before ? list.findIndex((s) => s.id === before.id) : list.length; list = [...list.slice(0, i), sc, ...list.slice(i)]; }
      return { ...c, shortcuts: list };
    });
    saveOrder(cats);
  };
  const moveCategory = (c: Category, before: Category) => {
    if (c.kind !== "user" || before.kind !== "user" || c.id === before.id) return;
    const rest = data.categories.filter((x) => x.id !== c.id);
    rest.splice(rest.findIndex((x) => x.id === before.id), 0, c);
    saveOrder(rest);
  };
  const addCategory = async (team?: { id: number }) => {
    const name = await ask({ title: "Neue Kategorie", label: "Name, z. B. Server, Smart Home, Medien", ok: "Anlegen", validate: (v) => (v.trim() ? null : "Bitte einen Namen eingeben.") });
    if (name?.trim()) run(api("/api/dashboard/categories", { method: "POST", body: { name, team: team?.id } }));
  };
  const heading = (c: Category) => (c.kind === "team" ? `Team ${c.team}: ${c.name}` : c.kind === "global" ? c.name : c.name);

  return (
    <div className={`dashboard${editing ? " editing" : ""}`}>
      <div className="dash-head">
        <h2>Dienste im Netz</h2>
        <span className="spacer" />
        <button onClick={() => setEditing(!editing)} aria-pressed={editing}>{editing ? "Fertig" : "Bearbeiten"}</button>
      </div>
      {!data.categories.length && (
        <section className="first-steps">
          <h3>Erste Schritte</h3>
          <ol>
            <li>Mit „Bearbeiten“ legst du Kategorien an, z. B. Server, Smart Home oder Medien.</li>
            <li>In jede Kategorie kommen Shortcuts: Name, Adresse und ein Symbol. Per Ziehen sortierst du um.</li>
            <li>Im Reiter „Wiki“ schreibst du Seiten und lädst Dateien hoch.</li>
            {data.is_admin && <li>Als Admin legst du unter Verwaltung → Teams Teams mit eigenem Bereich an und kannst hier Kategorien für alle vorgeben.</li>}
          </ol>
          <button className="primary" onClick={() => { setEditing(true); addCategory(); }}>Erste Kategorie anlegen</button>
        </section>
      )}
      {data.categories.map((c) => (
        <section key={c.id} className={`dash-cat kind-${c.kind}`}
          draggable={editing && c.kind === "user"} onDragStart={(e) => { if (e.target === e.currentTarget) drag.current = { cat: c }; }}
          onDragOver={(e) => { if (editing && drag.current) e.preventDefault(); }}
          onDrop={(e) => {
            if (!editing || !drag.current) return;
            e.preventDefault(); e.stopPropagation();
            if (drag.current.sc) moveShortcut(drag.current.sc, c);
            else if (drag.current.cat) moveCategory(drag.current.cat, c);
            drag.current = null;
          }}>
          <header>
            <h3>{editing && c.kind === "user" && <span className="grip" aria-hidden="true">⠿</span>}{heading(c)}
              {c.kind !== "user" && <span className={`badge scope-${c.kind}`}>{c.kind === "team" ? "Team" : "Für alle"}</span>}</h3>
            {editing && c.editable && (
              <span className="cat-actions">
                <button onClick={() => setForm({ cat: c })}>+ Shortcut</button>
                <button onClick={async () => { const n = await ask({ title: "Kategorie umbenennen", label: "Name", initial: c.name, ok: "Speichern" }); if (n?.trim()) run(api(`/api/dashboard/categories/${c.id}`, { method: "PATCH", body: { name: n } })); }}>Umbenennen</button>
                <button className="danger" onClick={async () => { if (await confirmDialog({ title: `Kategorie „${c.name}“ löschen?`, message: "Die Shortcuts darin werden mitgelöscht.", ok: "Löschen", danger: true })) run(api(`/api/dashboard/categories/${c.id}`, { method: "DELETE" })); }}>Löschen</button>
              </span>
            )}
          </header>
          <ul className="tiles">
            {c.shortcuts.map((s) => (
              <li key={s.id} draggable={editing && c.editable}
                onDragStart={(e) => { e.stopPropagation(); drag.current = { sc: s }; }}
                onDragOver={(e) => { if (editing && drag.current?.sc) e.preventDefault(); }}
                onDrop={(e) => { if (editing && drag.current?.sc) { e.preventDefault(); e.stopPropagation(); moveShortcut(drag.current.sc, c, s); drag.current = null; } }}>
                <a className="tile" href={s.url.startsWith("tcp://") ? undefined : s.url} target="_blank" rel="noopener noreferrer" title={s.description || undefined}
                  onClick={(e) => { if (editing) e.preventDefault(); }}>
                  <Icon s={s} />
                  <span className="tile-name">{s.name}</span>
                  <span className="tile-url muted">{s.description || s.url.replace(/^https?:\/\//, "")}</span>
                  <span className={`dot ${s.online ? "up" : "down"}`} title={s.online ? "erreichbar" : "nicht erreichbar"} aria-label={s.online ? "erreichbar" : "nicht erreichbar"} />
                </a>
                {editing && c.editable && (
                  <span className="tile-actions">
                    <button className="icon-btn" aria-label={`${s.name} bearbeiten`} onClick={() => setForm({ cat: c, sc: s })}>✎</button>
                    <button className="icon-btn" aria-label={`${s.name} löschen`} onClick={async () => { if (await confirmDialog({ title: `„${s.name}“ löschen?`, ok: "Löschen", danger: true })) run(api(`/api/dashboard/shortcuts/${s.id}`, { method: "DELETE" })); }}>🗑️</button>
                  </span>
                )}
              </li>
            ))}
            {!c.shortcuts.length && <li className="muted">Noch keine Shortcuts{editing && c.editable ? " – oben „+ Shortcut“." : "."}</li>}
          </ul>
        </section>
      ))}
      {editing && (
        <div className="dash-add">
          <button onClick={() => addCategory()}>+ Eigene Kategorie</button>
          {data.teams.map((t) => <button key={t.id} onClick={() => addCategory(t)}>+ Kategorie für Team {t.name}</button>)}
          {data.is_admin && <button onClick={async () => { const name = await ask({ title: "Globale Kategorie", label: "Name", ok: "Anlegen" }); if (name?.trim()) run(api("/api/dashboard/categories", { method: "POST", body: { name, global: true } })); }}>+ Globale Kategorie (alle)</button>}
        </div>
      )}
      {!editing && !data.categories.some((c) => c.kind === "user") && <p className="muted">Mit „Bearbeiten“ legst du eigene Kategorien und Shortcuts an.</p>}
      {form && <ShortcutForm {...form} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

function ShortcutForm({ cat, sc, onClose, onSaved }: { cat: Category; sc?: Shortcut; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ name: sc?.name ?? "", url: sc?.url ?? "https://", icon: sc?.icon ?? "🔗", description: sc?.description ?? "" });
  useEffect(() => ref.current?.showModal(), []);
  const save = async () => {
    try {
      if (sc) await api(`/api/dashboard/shortcuts/${sc.id}`, { method: "PATCH", body: f });
      else await api("/api/dashboard/shortcuts", { method: "POST", body: { ...f, category: cat.id } });
      onSaved();
    } catch (e) { err(e); }
  };
  return (
    <dialog ref={ref} className="dialog modal" aria-label="Shortcut" onClose={onClose}>
      <h2>{sc ? "Shortcut ändern" : `Neuer Shortcut in „${cat.name}“`}</h2>
      <div className="form-grid">
        <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
        <label>Adresse<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label>Beschreibung (optional)<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
      </div>
      <fieldset className="icon-pick"><legend>Symbol</legend>
        {ICONS.map((i) => <button key={i} type="button" aria-pressed={f.icon === i} onClick={() => setF({ ...f, icon: i })}>{i}</button>)}
        <button type="button" aria-pressed={f.icon === "favicon"} onClick={() => setF({ ...f, icon: "favicon" })}>Favicon der Seite</button>
      </fieldset>
      <div className="actions"><button onClick={() => ref.current?.close()}>Abbrechen</button><button className="primary" onClick={save} disabled={!f.name.trim()}>Speichern</button></div>
    </dialog>
  );
}

/** The five pages this user opened last; links open in tabs like every other page link. */
export function Recent() {
  const [items, setItems] = useState<{ id: string; title: string; area: string; at: string }[] | null>(null);
  useEffect(() => { api<typeof items>("/api/recent").then(setItems).catch(() => setItems([])); }, []);
  if (!items?.length) return null;
  return (
    <section className="recent ov-box">
      <h2>Zuletzt besucht</h2>
      <ul>
        {items.map((r) => (
          <li key={r.id}><a href={`/n/${r.id}`}><LineIcon name="fileText" size={16} /> <strong>{r.title}</strong></a>
            <span className="muted">{r.area} · {formatDate(r.at)}</span></li>
        ))}
      </ul>
    </section>
  );
}
