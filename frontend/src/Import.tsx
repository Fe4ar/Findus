import { useEffect, useRef, useState } from "react";
import { api, ApiError, formatSize } from "./api";
import { Icon } from "./Icons";

// Folder import: the browser reads the local folder, the files go up one by one (progress, report); the server creates
// the folders, cleans the names and refuses odd paths. Limits keep a wrong click from filling the wiki.
const MAX_FILES = 500, MAX_FILE_MB = 200, MAX_TOTAL_MB = 1024, PARALLEL = 3;
const IGNORED = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

interface Item { file: File; path: string }
interface Report { created: number; updated: number; failed: { path: string; reason: string }[] }

async function readEntry(entry: any, out: Item[]): Promise<void> {
  if (entry.isFile) {
    const file: File = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, "") });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {  // readEntries returns at most ~100 entries per call
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, out);
    }
  }
}

export function ImportDialog({ parent, title, onClose, onDone }: { parent: string; title: string; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [done, setDone] = useState(0);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => ref.current?.showModal(), []);

  const take = (all: Item[]) => {
    const skip: string[] = [];
    const ok = all.filter((i) => {
      if (IGNORED.test(i.path)) return false;
      if (i.file.size > MAX_FILE_MB * 1024 * 1024) { skip.push(`${i.path}: größer als ${MAX_FILE_MB} MB`); return false; }
      return true;
    });
    let total = 0;
    const kept: Item[] = [];
    for (const i of ok) {
      if (kept.length >= MAX_FILES) { skip.push(`${i.path}: mehr als ${MAX_FILES} Dateien`); continue; }
      if (total + i.file.size > MAX_TOTAL_MB * 1024 * 1024) { skip.push(`${i.path}: Gesamtgröße über ${MAX_TOTAL_MB} MB`); continue; }
      total += i.file.size;
      kept.push(i);
    }
    setItems(kept); setSkipped(skip); setReport(null);
  };

  const run = async () => {
    setRunning(true); setDone(0);
    const rep: Report = { created: 0, updated: 0, failed: [] };
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const it = items[next++];
        const form = new FormData();
        form.append("parent", parent); form.append("path", it.path); form.append("file", it.file);
        try {
          const r = await api<{ created: boolean }>("/api/import", { method: "POST", body: form });
          r.created ? rep.created++ : rep.updated++;
        } catch (e) {
          rep.failed.push({ path: it.path, reason: e instanceof ApiError ? e.message : "Fehler" });
        }
        setDone((d) => d + 1);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    setReport(rep); setRunning(false); onDone();
  };

  const total = items.reduce((n, i) => n + i.file.size, 0);
  return (
    <dialog ref={ref} className="dialog modal wide" aria-label="Ordner importieren" onClose={onClose}
      onCancel={(e) => { if (running) e.preventDefault(); }}>
      <h2>Ordner importieren</h2>
      <p className="muted">Ziel: <strong>{title}</strong>. Unterordner werden zu Ordnern, Dateien zu Dokumenten darin. Gleiche Dateinamen bekommen eine neue Version.</p>
      {!report && (
        <div className={`dropzone${drag ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={async (e) => {
            e.preventDefault(); setDrag(false);
            const out: Item[] = [];
            for (const it of Array.from(e.dataTransfer.items)) { const en = (it as any).webkitGetAsEntry?.(); if (en) await readEntry(en, out); }
            take(out);
          }}>
          <Icon name="upload" size={28} />
          <p>Ordner hierher ziehen oder</p>
          <label className="button">Ordner wählen …
            <input type="file" hidden disabled={running} {...({ webkitdirectory: "", directory: "" } as object)} multiple
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                take(files.map((f) => ({ file: f, path: (f as any).webkitRelativePath || f.name })));
              }} />
          </label>
        </div>
      )}
      {!!items.length && !report && (
        <p>{items.length} Dateien, {formatSize(total)}{running && <> · <strong>{done} / {items.length}</strong></>}</p>
      )}
      {running && <progress className="import-progress" max={items.length} value={done} />}
      {!!skipped.length && !report && (
        <details open><summary>{skipped.length} Dateien übersprungen</summary><ul className="import-list">{skipped.slice(0, 50).map((s) => <li key={s}>{s}</li>)}</ul></details>
      )}
      {report && (
        <div role="status">
          <p><strong>{report.created}</strong> neu angelegt, <strong>{report.updated}</strong> als neue Version, <strong>{report.failed.length}</strong> fehlgeschlagen{skipped.length ? `, ${skipped.length} übersprungen` : ""}.</p>
          {!!report.failed.length && <ul className="import-list">{report.failed.slice(0, 50).map((f) => <li key={f.path}>{f.path}: {f.reason}</li>)}</ul>}
        </div>
      )}
      <div className="actions">
        <button disabled={running} onClick={() => ref.current?.close()}>{report ? "Schließen" : "Abbrechen"}</button>
        {!report && <button className="primary" disabled={!items.length || running} onClick={run}>Importieren</button>}
      </div>
    </dialog>
  );
}
