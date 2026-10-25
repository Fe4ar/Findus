import { useEffect, useState } from "react";
import { api } from "./api";

interface Row {
  nr: string;
  task: string;
  who: string;
  status: string;
  note: string;
}

const ORDER = ["Zentrale", "worker01", "worker02", "worker03", "User"];
const DONE = ["✅", "✖"];
const LABELS: Record<string, string> = { "⏳": "offen", "🔄": "läuft", "✅": "fertig", "❓": "wartet auf User", "✖": "abgebrochen" };

export function Tasks() {
  const [board, setBoard] = useState<{ updated: string | null; rows: Row[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => api<{ updated: string | null; rows: Row[] }>("/api/board").then(setBoard)
      .catch(() => setError("Aufgaben konnten nicht geladen werden."));
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!board) return <p className="muted">Aufgaben werden geladen …</p>;
  if (!board.rows.length) return <p className="muted">Keine Aufgaben auf dem Brett.</p>;
  const groups = [...new Set([...ORDER, ...board.rows.map((r) => r.who)])].filter((g) => board.rows.some((r) => r.who === g));
  return (
    <div className="tasks">
      <p className="muted">Quelle: Auftragsbrett der Zentrale, Stand {board.updated ? new Date(board.updated).toLocaleString("de-DE") : "unbekannt"}</p>
      <div className="task-groups">
        {groups.map((g) => {
          const rows = board.rows.filter((r) => r.who === g);
          const open = rows.filter((r) => !DONE.includes(r.status));
          const done = rows.filter((r) => DONE.includes(r.status));
          return (
            <section key={g} className="task-group">
              <h3>{g} <span className="muted">({open.length} offen)</span></h3>
              {open.length ? <TaskList rows={open} /> : <p className="muted">Nichts offen.</p>}
              {done.length > 0 && (
                <details>
                  <summary>Erledigt ({done.length})</summary>
                  <TaskList rows={done} />
                </details>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TaskList({ rows }: { rows: Row[] }) {
  return (
    <ul className="task-list">
      {rows.map((r, i) => (
        <li key={`${r.nr}-${i}`}>
          <span className="task-status" title={LABELS[r.status] ?? r.status} aria-label={LABELS[r.status] ?? r.status}>{r.status}</span>
          <span>
            {r.task}
            {r.nr !== "—" && <span className="muted"> #{r.nr}</span>}
            {r.note && <span className="task-note muted">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
