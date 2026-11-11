import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, formatDate } from "./api";
import { Icon as LineIcon } from "./Icons";
import { ask, confirmDialog, notify } from "./Dialog";
import { tr } from "./i18n";

// Personal dashboard: global shortcuts (admins), one category per team (leaders) and the user's own categories.
// Own categories and shortcuts can be reordered and moved by drag & drop; the order is stored per user.
// A category can hold folders (collapsible, the open/closed state is remembered per browser); searching opens the folders with hits.
const COLLAPSED_KEY = "findus-dash-folders-collapsed";
const loadCollapsed = (): Set<number> => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]")); } catch { return new Set(); } };

interface Shortcut { id: number; name: string; url: string; icon: string; description: string; online: boolean | null; folder: number | null }
interface Folder { id: number; name: string; icon: string }
interface Category { id: number; name: string; kind: "global" | "team" | "user"; team: string | null; team_id: number | null; editable: boolean; folders: Folder[]; shortcuts: Shortcut[] }
interface Data { categories: Category[]; teams: { id: number; name: string }[]; is_admin: boolean }

const ICONS = ["🔗", "🖥️", "🗄️", "📡", "🔀", "🛡️", "🔁", "🏠", "💡", "🎬", "🎵", "📷", "🖨️", "☁️", "📦", "🔧", "📊", "🎮", "📧", "📁"];
const err = (e: unknown) => notify(e instanceof ApiError ? e.message : tr("Aktion fehlgeschlagen."));

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
  const [q, setQ] = useState(""); // live filter of the shortcuts (name, description, address); off while editing so reordering stays unambiguous
  const [form, setForm] = useState<{ cat: Category; sc?: Shortcut; folder?: number | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(loadCollapsed);
  const toggleFolder = (id: number) => setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...n])); } catch { /* not remembered */ } return n; });
  const drag = useRef<{ sc?: Shortcut; cat?: Category; folder?: Folder; fromCat?: Category } | null>(null);
  const load = useCallback(() => api<Data>("/api/dashboard").then(setData).catch(() => setError(tr("Dienste konnten nicht geladen werden."))), []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return <p className="muted">{tr("Dienste werden geprüft …")}</p>;

  const run = (p: Promise<unknown>) => p.then(load).catch(err);
  const saveOrder = (cats: Category[]) => {
    setData({ ...data, categories: cats });
    const mine = cats.filter((c) => c.editable);
    api("/api/dashboard/order", { method: "PUT", body: {
      categories: mine.map((c) => c.id),
      shortcuts: Object.fromEntries(mine.map((c) => [c.id, c.shortcuts.filter((s) => s.folder == null).map((s) => s.id)])),
      folders: Object.fromEntries(mine.map((c) => [c.id, c.folders.map((f) => f.id)])),
      folder_shortcuts: Object.fromEntries(mine.flatMap((c) => c.folders.map((f) => [f.id, c.shortcuts.filter((s) => s.folder === f.id).map((s) => s.id)]))),
    } }).catch(err);
  };
  // Moves a shortcut into a category (loose) or into one of its folders, in front of another shortcut or at the end.
  const moveShortcut = (sc: Shortcut, to: Category, before?: Shortcut, folder: Folder | null = null) => {
    const from = data.categories.find((c) => c.shortcuts.some((s) => s.id === sc.id))!;
    if (from.kind !== to.kind || from.team_id !== to.team_id) return;
    const moved = { ...sc, folder: folder ? folder.id : null };
    const cats = data.categories.map((c) => {
      let list = c.shortcuts.filter((s) => s.id !== sc.id);
      if (c.id === to.id) { const i = before ? list.findIndex((s) => s.id === before.id) : list.length; list = [...list.slice(0, i), moved, ...list.slice(i)]; }
      return { ...c, shortcuts: list };
    });
    if (folder && collapsed.has(folder.id)) toggleFolder(folder.id);
    saveOrder(cats);
  };
  const moveFolder = (f: Folder, cat: Category, before?: Folder) => {
    if (!cat.folders.some((x) => x.id === f.id) || (before && before.id === f.id)) return;
    const rest = cat.folders.filter((x) => x.id !== f.id);
    rest.splice(before ? rest.findIndex((x) => x.id === before.id) : rest.length, 0, f);
    saveOrder(data.categories.map((c) => (c.id === cat.id ? { ...c, folders: rest } : c)));
  };
  const addFolder = async (c: Category) => {
    const name = await ask({ title: tr("Neuer Ordner"), label: tr("Name"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (name?.trim()) run(api("/api/dashboard/folders", { method: "POST", body: { category: c.id, name } }));
  };
  const moveCategory = (c: Category, before: Category) => {
    if (c.kind !== "user" || before.kind !== "user" || c.id === before.id) return;
    const rest = data.categories.filter((x) => x.id !== c.id);
    rest.splice(rest.findIndex((x) => x.id === before.id), 0, c);
    saveOrder(rest);
  };
  const addCategory = async (team?: { id: number }) => {
    const name = await ask({ title: tr("Neue Kategorie"), label: tr("Name, z. B. Server, Smart Home, Medien"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (name?.trim()) run(api("/api/dashboard/categories", { method: "POST", body: { name, team: team?.id } }));
  };
  const needle = editing ? "" : q.trim().toLowerCase();
  // Searching looks into the folders too: folders with hits are shown (opened), folders without hits are hidden.
  const shown = !needle ? data.categories : data.categories
    .map((c) => ({ ...c, shortcuts: c.shortcuts.filter((s) => [s.name, s.description, s.url].some((v) => v.toLowerCase().includes(needle))) }))
    .map((c) => ({ ...c, folders: c.folders.filter((f) => c.shortcuts.some((s) => s.folder === f.id)) }))
    .filter((c) => c.shortcuts.length);
  const heading = (c: Category) => (c.kind === "team" ? tr("Team {team}: {name}", { team: c.team, name: c.name }) : c.kind === "global" ? c.name : c.name);

  return (
    <div className={`dashboard${editing ? " editing" : ""}`}>
      <div className="dash-head">
        <h2>{tr("Dienste im Netz")}</h2>
        <span className="spacer" />
        {data.categories.some((c) => c.shortcuts.length > 0) && !editing && (
          <input type="search" className="dash-search" placeholder={tr("Shortcuts suchen …")} aria-label={tr("Shortcuts suchen")} value={q} onChange={(e) => setQ(e.target.value)} />
        )}
        <button onClick={() => setEditing(!editing)} aria-pressed={editing}>{editing ? tr("Fertig") : tr("Bearbeiten")}</button>
      </div>
      {!data.categories.length && (
        <section className="first-steps">
          <h3>{tr("Erste Schritte")}</h3>
          <ol>
            <li>{tr("Mit „Bearbeiten“ legst du Kategorien an, z. B. Server, Smart Home oder Medien.")}</li>
            <li>{tr("In jede Kategorie kommen Shortcuts: Name, Adresse und ein Symbol. Per Ziehen sortierst du um.")}</li>
            <li>{tr("Im Reiter „Wiki“ schreibst du Seiten und lädst Dateien hoch.")}</li>
            {data.is_admin && <li>{tr("Als Admin legst du unter Verwaltung → Teams Teams mit eigenem Bereich an und kannst hier Kategorien für alle vorgeben.")}</li>}
          </ol>
          <button className="primary" onClick={() => { setEditing(true); addCategory(); }}>{tr("Erste Kategorie anlegen")}</button>
        </section>
      )}
      {needle && !shown.length && <p className="muted">{tr("Keine Shortcuts gefunden.")}</p>}
      {shown.map((c) => (
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
              {c.kind !== "user" && <span className={`badge scope-${c.kind}`}>{c.kind === "team" ? tr("Team") : tr("Für alle")}</span>}</h3>
            {editing && c.editable && (
              <span className="cat-actions">
                <button onClick={() => setForm({ cat: c })}>{tr("+ Shortcut")}</button>
                <button onClick={() => addFolder(c)}>{tr("+ Ordner")}</button>
                <button onClick={async () => { const n = await ask({ title: tr("Kategorie umbenennen"), label: tr("Name"), initial: c.name, ok: tr("Speichern") }); if (n?.trim()) run(api(`/api/dashboard/categories/${c.id}`, { method: "PATCH", body: { name: n } })); }}>{tr("Umbenennen")}</button>
                <button className="danger" onClick={async () => { if (await confirmDialog({ title: tr("Kategorie „{name}“ löschen?", { name: c.name }), message: tr("Die Shortcuts darin werden mitgelöscht."), ok: tr("Löschen"), danger: true })) run(api(`/api/dashboard/categories/${c.id}`, { method: "DELETE" })); }}>{tr("Löschen")}</button>
              </span>
            )}
          </header>
          {(() => {
            const tile = (s: Shortcut, folder: Folder | null) => (
              <li key={s.id} draggable={editing && c.editable}
                onDragStart={(e) => { e.stopPropagation(); drag.current = { sc: s }; }}
                onDragOver={(e) => { if (editing && drag.current?.sc) e.preventDefault(); }}
                onDrop={(e) => { if (editing && drag.current?.sc) { e.preventDefault(); e.stopPropagation(); moveShortcut(drag.current.sc, c, s, folder); drag.current = null; } }}>
                <a className="tile" href={s.url.startsWith("tcp://") ? undefined : s.url} target="_blank" rel="noopener noreferrer" title={s.description || undefined}
                  onClick={(e) => { if (editing) e.preventDefault(); }}>
                  <Icon s={s} />
                  <span className="tile-name">{s.name}</span>
                  <span className="tile-url muted">{s.description || s.url.replace(/^https?:\/\//, "")}</span>
                  <span className={`dot ${s.online ? "up" : "down"}`} title={s.online ? tr("erreichbar") : tr("nicht erreichbar")} aria-label={s.online ? tr("erreichbar") : tr("nicht erreichbar")} />
                </a>
                {editing && c.editable && (
                  <span className="tile-actions">
                    <button className="icon-btn" aria-label={tr("{name} bearbeiten", { name: s.name })} onClick={() => setForm({ cat: c, sc: s })}>✎</button>
                    <button className="icon-btn" aria-label={tr("{name} löschen", { name: s.name })} onClick={async () => { if (await confirmDialog({ title: tr("„{name}“ löschen?", { name: s.name }), ok: tr("Löschen"), danger: true })) run(api(`/api/dashboard/shortcuts/${s.id}`, { method: "DELETE" })); }}>🗑️</button>
                  </span>
                )}
              </li>
            );
            const loose = c.shortcuts.filter((s) => s.folder == null);
            return (
              <>
                {(loose.length > 0 || !c.folders.length) && (
                  <ul className="tiles">
                    {loose.map((s) => tile(s, null))}
                    {!c.shortcuts.length && <li className="muted">{tr("Noch keine Shortcuts")}{editing && c.editable ? tr(" – oben „+ Shortcut“.") : "."}</li>}
                  </ul>
                )}
                {c.folders.map((f) => {
                  const items = c.shortcuts.filter((s) => s.folder === f.id);
                  const open = !!needle || !collapsed.has(f.id);
                  return (
                    <div key={f.id} className={`dash-folder${open ? " open" : ""}`}
                      onDragOver={(e) => { if (editing && drag.current && (drag.current.sc || drag.current.folder)) e.preventDefault(); }}
                      onDrop={(e) => {
                        if (!editing || !drag.current) return;
                        e.preventDefault(); e.stopPropagation();
                        if (drag.current.sc) moveShortcut(drag.current.sc, c, undefined, f);
                        else if (drag.current.folder) moveFolder(drag.current.folder, c, f);
                        drag.current = null;
                      }}>
                      <div className="dash-folder-head" draggable={editing && c.editable} onDragStart={(e) => { e.stopPropagation(); drag.current = { folder: f }; }}>
                        <button type="button" className="folder-toggle" aria-expanded={open} onClick={() => toggleFolder(f.id)}>
                          <LineIcon name="chevron" size={14} /><span aria-hidden="true">{f.icon}</span><strong>{f.name}</strong><small className="muted">{items.length}</small>
                        </button>
                        {editing && c.editable && (
                          <span className="cat-actions">
                            <button onClick={() => setForm({ cat: c, folder: f.id })}>{tr("+ Shortcut")}</button>
                            <button onClick={async () => { const n = await ask({ title: tr("Ordner umbenennen"), label: tr("Name"), initial: f.name, ok: tr("Speichern") }); if (n?.trim()) run(api(`/api/dashboard/folders/${f.id}`, { method: "PATCH", body: { name: n } })); }}>{tr("Umbenennen")}</button>
                            <button className="danger" onClick={async () => { if (await confirmDialog({ title: tr("Ordner „{name}“ löschen?", { name: f.name }), message: tr("Die Shortcuts darin bleiben erhalten."), ok: tr("Löschen"), danger: true })) run(api(`/api/dashboard/folders/${f.id}`, { method: "DELETE" })); }}>{tr("Löschen")}</button>
                          </span>
                        )}
                      </div>
                      {open && (
                        <ul className="tiles">
                          {items.map((s) => tile(s, f))}
                          {!items.length && <li className="muted">{tr("Ordner ist leer.")}{editing && c.editable ? " " + tr("Shortcuts hierher ziehen.") : ""}</li>}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </>
            );
          })()}
        </section>
      ))}
      {editing && (
        <div className="dash-add">
          <button onClick={() => addCategory()}>{tr("+ Eigene Kategorie")}</button>
          {data.teams.map((t) => <button key={t.id} onClick={() => addCategory(t)}>{tr("+ Kategorie für Team")}{" "}{t.name}</button>)}
          {data.is_admin && <button onClick={async () => { const name = await ask({ title: tr("Globale Kategorie"), label: tr("Name"), ok: tr("Anlegen") }); if (name?.trim()) run(api("/api/dashboard/categories", { method: "POST", body: { name, global: true } })); }}>{tr("+ Globale Kategorie (alle)")}</button>}
        </div>
      )}
      {!editing && !data.categories.some((c) => c.kind === "user") && <p className="muted">{tr("Mit „Bearbeiten“ legst du eigene Kategorien und Shortcuts an.")}</p>}
      {form && <ShortcutForm {...form} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
    </div>
  );
}

function ShortcutForm({ cat, sc, folder, onClose, onSaved }: { cat: Category; sc?: Shortcut; folder?: number | null; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ name: sc?.name ?? "", url: sc?.url ?? "https://", icon: sc?.icon ?? "🔗", description: sc?.description ?? "" });
  const [inFolder, setInFolder] = useState<number | null>(sc ? sc.folder : folder ?? null);
  useEffect(() => ref.current?.showModal(), []);
  const save = async () => {
    try {
      if (sc) await api(`/api/dashboard/shortcuts/${sc.id}`, { method: "PATCH", body: { ...f, folder: inFolder } });
      else await api("/api/dashboard/shortcuts", { method: "POST", body: { ...f, category: cat.id, folder: inFolder } });
      onSaved();
    } catch (e) { err(e); }
  };
  return (
    <dialog ref={ref} className="dialog modal" aria-label={tr("Shortcut")} onClose={onClose}>
      <h2>{sc ? tr("Shortcut ändern") : tr("Neuer Shortcut in „{name}“", { name: cat.name })}</h2>
      <div className="form-grid">
        <label>{tr("Name")}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></label>
        <label>{tr("Adresse")}<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label>{tr("Beschreibung (optional)")}<input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        {cat.folders.length > 0 && <label>{tr("Ordner")}<select value={inFolder ?? ""} onChange={(e) => setInFolder(e.target.value ? Number(e.target.value) : null)}><option value="">{tr("– keiner –")}</option>{cat.folders.map((x) => <option key={x.id} value={x.id}>{x.icon} {x.name}</option>)}</select></label>}
      </div>
      <fieldset className="icon-pick"><legend>{tr("Symbol")}</legend>
        {ICONS.map((i) => <button key={i} type="button" aria-pressed={f.icon === i} onClick={() => setF({ ...f, icon: i })}>{i}</button>)}
        <button type="button" aria-pressed={f.icon === "favicon"} onClick={() => setF({ ...f, icon: "favicon" })}>{tr("Favicon der Seite")}</button>
      </fieldset>
      <div className="actions"><button onClick={() => ref.current?.close()}>{tr("Abbrechen")}</button><button className="primary" onClick={save} disabled={!f.name.trim()}>{tr("Speichern")}</button></div>
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
      <h2>{tr("Zuletzt besucht")}</h2>
      <ul>
        {items.map((r) => (
          <li key={r.id}><a href={`/n/${r.id}`}><LineIcon name="fileText" size={16} /> <strong>{r.title}</strong></a>
            <span className="muted">{r.area} · {formatDate(r.at)}</span></li>
        ))}
      </ul>
    </section>
  );
}
