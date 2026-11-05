import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ask, confirmDialog, notify } from "./Dialog";

// Personal tasks (backend: tasks.py). Not to be confused with Tasks.tsx, the read-only job board file on the overview.

interface Task {
  id: number; title: string; notes: string; due: string | null; done: boolean; private: boolean; section: number | null;
  owner: { id: number; name: string }; mine: boolean; created_by: string | null; editable: boolean; overdue: boolean; todoist: boolean;
}
interface Person { id: number; name: string }
interface Section { id: number; title: string }
type Move = (taskId: number, section: number | null, before: number | null) => void;

const err = (e: unknown) => notify(e instanceof ApiError ? e.message : "Aktion fehlgeschlagen.");
const stored = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const store = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* storage unavailable */ } };
const day = (iso: string) => new Date(`${iso}T00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

function useTasks(done: boolean) {
  const [colleagues, setColleagues] = useState(() => stored("tasks-colleagues"));
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<Task[]>(`/api/tasks?colleagues=${colleagues ? 1 : 0}&done=${done ? 1 : 0}`)
    .then((t) => { setTasks(t); setError(""); }).catch((e) => setError(e instanceof ApiError ? e.message : "Aufgaben konnten nicht geladen werden.")), [colleagues, done]);
  useEffect(() => { load(); }, [load]);
  return { tasks, error, load, colleagues, setColleagues: (on: boolean) => { store("tasks-colleagues", on); setColleagues(on); } };
}

function TaskForm({ task, people, onClose, onSaved }: { task: Task | null; people: Person[]; onClose: () => void; onSaved: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [due, setDue] = useState(task?.due ?? "");
  const [priv, setPriv] = useState(task?.private ?? false);
  const [owner, setOwner] = useState<number | "">(task && !task.mine ? task.owner.id : "");
  const [history, setHistory] = useState<{ at: string; text: string }[]>([]);
  useEffect(() => {
    if (task?.todoist) api<{ at: string; text: string }[]>(`/api/tasks/${task.id}/history`).then(setHistory).catch(() => setHistory([]));
  }, [task]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { title, notes, due: due || null, private: priv, ...(owner !== "" ? { user: owner } : task ? { user: task.owner.id } : {}) };
    try {
      await (task ? api(`/api/tasks/${task.id}`, { method: "PATCH", body }) : api("/api/tasks", { method: "POST", body }));
      ref.current?.close();
      onSaved();
    } catch (x) { err(x); }
  };
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="task-form-title" onClose={onClose}>
      <h2 id="task-form-title">{task ? "Aufgabe bearbeiten" : "Neue Aufgabe"}</h2>
      <form onSubmit={submit} className="task-form">
        <label>Titel<input value={title} maxLength={200} autoFocus required onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Notizen<textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="form-grid">
          <label>Fällig am<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          {people.length > 0 && (
            <label>Für<select value={owner} onChange={(e) => setOwner(e.target.value ? +e.target.value : "")}>
              <option value="">mich selbst</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          )}
        </div>
        <label className="check-row"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Privat (Kollegen sehen die Aufgabe nicht)</label>
        {history.length > 0 && (
          <details className="task-history"><summary>Verlauf (Abgleich mit Todoist)</summary>
            <ul>{history.map((h, i) => <li key={i}><time dateTime={h.at}>{new Date(h.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</time> {h.text}</li>)}</ul>
          </details>
        )}
        <div className="actions">
          <span className="spacer" />
          <button type="button" onClick={() => ref.current?.close()}>Abbrechen</button>
          <button className="primary" disabled={!title.trim()}>Speichern</button>
        </div>
      </form>
    </dialog>
  );
}

interface Place { sections: Section[]; siblings: Task[]; move: Move }

function Row({ t, onChange, onEdit, place }: { t: Task; onChange: () => void; onEdit: (t: Task) => void; place?: Place }) {
  const toggle = () => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { done: !t.done } }).then(onChange).catch(err);
  const remove = async () => {
    if (await confirmDialog({ title: "Aufgabe löschen?", message: t.title, ok: "Löschen", danger: true })) api(`/api/tasks/${t.id}`, { method: "DELETE" }).then(onChange).catch(err);
  };
  const [over, setOver] = useState(false);
  const movable = !!place && t.mine;
  const i = place ? place.siblings.findIndex((x) => x.id === t.id) : -1;
  return (
    <li className={`task-row${t.done ? " done" : ""}${place ? " movable" : ""}${over ? " drop-before" : ""}`}
      draggable={movable} onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData("text/x-task", String(t.id)); }}
      onDragOver={(e) => { if (movable && e.dataTransfer.types.includes("text/x-task")) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const d = +e.dataTransfer.getData("text/x-task"); if (movable && d && d !== t.id) { e.preventDefault(); e.stopPropagation(); place!.move(d, t.section, t.id); } }}>
      <input type="checkbox" checked={t.done} disabled={!t.editable} aria-label={`${t.title} erledigt`} onChange={toggle} />
      {place && <span className="grip" aria-hidden="true" title={movable ? "Ziehen zum Verschieben" : undefined}>{movable ? "⠿" : ""}</span>}
      <span className="task-main">
        <span className="task-title">{t.title}{t.private && <span title="Privat" aria-label="privat"> 🔒</span>}
          {t.todoist && <span className="chip task-sync" title="Wird mit Todoist abgeglichen">Todoist</span>}</span>
        {t.notes && <span className="task-note muted">{t.notes}</span>}
      </span>
      {t.due && <span className={`task-due${t.overdue ? " overdue" : ""}`} title={t.overdue ? "überfällig" : "fällig"}>{day(t.due)}</span>}
      {t.editable && (
        <span className="task-actions">
          {movable && (
            <>
              <select className="task-move" aria-label={`${t.title} verschieben nach`} value="" onChange={(e) => { const v = e.target.value; if (v) place!.move(t.id, v === "none" ? null : +v, null); }}>
                <option value="">Verschieben …</option>
                {t.section !== null && <option value="none">Ohne Bereich</option>}
                {place!.sections.filter((x) => x.id !== t.section).map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
              <button className="icon-btn" aria-label={`${t.title} nach oben`} title="Nach oben" disabled={i <= 0} onClick={() => place!.move(t.id, t.section, place!.siblings[i - 1].id)}>↑</button>
              <button className="icon-btn" aria-label={`${t.title} nach unten`} title="Nach unten" disabled={i < 0 || i >= place!.siblings.length - 1}
                onClick={() => place!.move(t.id, t.section, place!.siblings[i + 2]?.id ?? null)}>↓</button>
            </>
          )}
          <button className="icon-btn" aria-label={`${t.title} bearbeiten`} title="Bearbeiten" onClick={() => onEdit(t)}>✎</button>
          <button className="icon-btn" aria-label={`${t.title} löschen`} title="Löschen" onClick={remove}>✕</button>
        </span>
      )}
    </li>
  );
}

/** One section of the own board (or "Ohne Bereich" when `section` is null): drop target for tasks and, with a name, draggable itself. */
function SectionBox({ section, rows, sections, index, load, move, onEdit }: {
  section: Section | null; rows: Task[]; sections: Section[]; index: number; load: () => void; move: Move; onEdit: (t: Task) => void;
}) {
  const [over, setOver] = useState(false);
  const run = (p: Promise<unknown>) => p.then(load).catch(err);
  const rename = async () => {
    const title = await ask({ title: "Bereich umbenennen", initial: section!.title });
    if (title?.trim()) run(api(`/api/tasks/sections/${section!.id}`, { method: "PATCH", body: { title } }));
  };
  const remove = async () => {
    if (await confirmDialog({ title: "Bereich löschen?", message: `„${section!.title}“ wird gelöscht, seine Aufgaben bleiben erhalten („Ohne Bereich“).`, ok: "Löschen", danger: true })) run(api(`/api/tasks/sections/${section!.id}`, { method: "DELETE" }));
  };
  const reorder = (before: number | null) => run(api(`/api/tasks/sections/${section!.id}/move`, { method: "POST", body: { before } }));
  const open = rows.filter((t) => !t.done).length;
  return (
    <section className={`task-section${over ? " drop-target" : ""}`} aria-label={section?.title ?? "Ohne Bereich"}
      draggable={!!section} onDragStart={(e) => { if (section) e.dataTransfer.setData("text/x-tsec", String(section.id)); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("text/x-task") || (section && e.dataTransfer.types.includes("text/x-tsec"))) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        setOver(false);
        const t = +e.dataTransfer.getData("text/x-task"), sec = +e.dataTransfer.getData("text/x-tsec");
        if (t) { e.preventDefault(); move(t, section?.id ?? null, null); }
        else if (sec && section && sec !== section.id) { e.preventDefault(); run(api(`/api/tasks/sections/${sec}/move`, { method: "POST", body: { before: section.id } })); }
      }}>
      <header>
        {section && <span className="grip" aria-hidden="true" title="Ziehen zum Sortieren">⠿</span>}
        <h3>{section?.title ?? "Ohne Bereich"} <span className="muted">({open} offen)</span></h3>
        {section && (
          <span className="task-actions">
            <button className="icon-btn" aria-label={`${section.title} nach oben`} title="Nach oben" disabled={index === 0} onClick={() => reorder(sections[index - 1].id)}>↑</button>
            <button className="icon-btn" aria-label={`${section.title} nach unten`} title="Nach unten" disabled={index >= sections.length - 1} onClick={() => reorder(sections[index + 2]?.id ?? null)}>↓</button>
            <button className="icon-btn" aria-label={`${section.title} umbenennen`} title="Umbenennen" onClick={rename}>✎</button>
            <button className="icon-btn" aria-label={`${section.title} löschen`} title="Löschen" onClick={remove}>✕</button>
          </span>
        )}
      </header>
      {rows.length
        ? <ul className="task-items">{rows.map((t) => <Row key={t.id} t={t} onChange={load} onEdit={onEdit} place={{ sections, siblings: rows, move }} />)}</ul>
        : <p className="muted task-empty">Keine Aufgaben. Ziehe eine Aufgabe hierher.</p>}
    </section>
  );
}

/** Own open tasks (compact: for the overview) or the full page with colleagues, done tasks and grouping by person. */
export function TaskBoard({ compact = false, go }: { compact?: boolean; go?: (path: string) => void }) {
  const [showDone, setShowDone] = useState(() => !compact && stored("tasks-done"));
  const { tasks, error, load, colleagues, setColleagues } = useTasks(showDone);
  const [people, setPeople] = useState<Person[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const loadSections = useCallback(() => { if (!compact) api<Section[]>("/api/tasks/sections").then(setSections).catch(() => setSections([])); }, [compact]);
  useEffect(loadSections, [loadSections]);
  const reload = () => { load(); loadSections(); };
  const move: Move = (id, section, before) => api(`/api/tasks/${id}/move`, { method: "POST", body: { section, before } }).then(load).catch(err);
  const addSection = async () => {
    const title = await ask({ title: "Neuer Bereich", label: "Name" });
    if (title?.trim()) api("/api/tasks/sections", { method: "POST", body: { title } }).then(loadSections).catch(err);
  };
  const [form, setForm] = useState<Task | "new" | null>(null);
  useEffect(() => { api<Person[]>("/api/tasks/people").then(setPeople).catch(() => setPeople([])); }, []);
  // The link back from a Todoist task (/aufgaben?t=<id>) opens that task for editing, once.
  const opened = useRef(false);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("t");
    const hit = id && tasks?.find((x) => String(x.id) === id && x.editable);
    if (hit && !opened.current) { opened.current = true; setForm(hit); }
  }, [tasks]);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!tasks) return <p className="muted">Aufgaben werden geladen …</p>;
  const mine = tasks.filter((t) => t.mine);
  const others = new Map<number, { name: string; rows: Task[] }>();
  for (const t of tasks.filter((x) => !x.mine)) (others.get(t.owner.id) ?? others.set(t.owner.id, { name: t.owner.name, rows: [] }).get(t.owner.id)!).rows.push(t);
  const open = mine.filter((t) => !t.done).length;
  const list = (rows: Task[]) => <ul className="task-items">{rows.map((t) => <Row key={t.id} t={t} onChange={load} onEdit={setForm} />)}</ul>;
  return (
    <div className={compact ? "taskboard compact" : "taskboard"}>
      <div className="actions task-bar">
        <button className="primary" onClick={() => setForm("new")}>+ Aufgabe</button>
        {!compact && <button onClick={addSection}>+ Bereich</button>}
        <label className="check-row"><input type="checkbox" checked={colleagues} onChange={(e) => setColleagues(e.target.checked)} /> Aufgaben von Kollegen anzeigen</label>
        {!compact && <label className="check-row"><input type="checkbox" checked={showDone} onChange={(e) => { store("tasks-done", e.target.checked); setShowDone(e.target.checked); }} /> Alle erledigten</label>}
        <span className="spacer" />
        {compact && go && <a href="/aufgaben" onClick={(e) => { e.preventDefault(); go("/aufgaben"); }}>Alle Aufgaben</a>}
      </div>
      <section aria-label="Meine Aufgaben">
        {!compact && <h2>Meine Aufgaben <span className="muted">({open} offen)</span></h2>}
        {compact
          ? (mine.length ? list(mine.filter((t) => !t.done).slice(0, 8)) : <p className="muted">Keine Aufgaben. Mit „+ Aufgabe“ legst du eine an.</p>)
          : <div className="task-sections">
              {sections.map((sec, i) => <SectionBox key={sec.id} section={sec} rows={mine.filter((t) => t.section === sec.id)} sections={sections} index={i} load={reload} move={move} onEdit={setForm} />)}
              <SectionBox section={null} rows={mine.filter((t) => t.section === null)} sections={sections} index={-1} load={reload} move={move} onEdit={setForm} />
            </div>}
        {compact && open > 8 && <p className="muted">und {open - 8} weitere …</p>}
      </section>
      {colleagues && (others.size ? [...others.values()].map((g) => (
        <section key={g.name} aria-label={`Aufgaben von ${g.name}`}>
          <h3>{g.name} <span className="muted">({g.rows.filter((t) => !t.done).length} offen)</span></h3>
          {list(compact ? g.rows.filter((t) => !t.done) : g.rows)}
        </section>
      )) : <p className="muted">Deine Kollegen haben keine (öffentlichen) Aufgaben.</p>)}
      {form && <TaskForm task={form === "new" ? null : form} people={people} onClose={() => setForm(null)} onSaved={reload} />}
    </div>
  );
}
