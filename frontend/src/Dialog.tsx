import { FormEvent, useEffect, useRef, useState } from "react";
import { tr } from "./i18n";

// Replacements for window.prompt/confirm/alert in the design system. One <DialogHost /> in main.tsx renders them;
// the native <dialog> brings focus trapping, Esc and the backdrop.

interface AskOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  ok?: string;
  // Returns an error text to keep the dialog open, e.g. for invalid input.
  validate?: (value: string) => string | null;
}

interface ConfirmOptions {
  title: string;
  message?: string;
  ok?: string;
  danger?: boolean;
}

type Request = { id: number } & (
  | { kind: "ask"; opts: AskOptions; resolve: (v: string | null) => void }
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (v: boolean) => void });

interface Toast {
  id: number;
  text: string;
  error: boolean;
}

let queue: Request[] = [];
let toasts: Toast[] = [];
let listener: (() => void) | null = null;
let toastId = 0;
let reqId = 0;
const changed = () => listener?.();

/** Text input dialog; resolves to the entered text or null on cancel. */
export function ask(opts: AskOptions | string): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { id: ++reqId, kind: "ask", opts: typeof opts === "string" ? { title: opts } : opts, resolve }];
    changed();
  });
}

/** Yes/no dialog; resolves to true when confirmed. */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { id: ++reqId, kind: "confirm", opts: typeof opts === "string" ? { title: opts } : opts, resolve }];
    changed();
  });
}

/** Short message in the corner, gone after a few seconds (errors stay longer). */
export function notify(text: string, error = true) {
  const id = ++toastId;
  toasts = [...toasts, { id, text, error }];
  changed();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    changed();
  }, error ? 8000 : 4000);
}

export function DialogHost() {
  const [, rerender] = useState(0);
  useEffect(() => {
    listener = () => rerender((n) => n + 1);
    return () => {
      listener = null;
    };
  }, []);
  const current = queue[0];
  const done = (value: string | boolean | null) => {
    queue = queue.slice(1);
    (current.resolve as (v: string | boolean | null) => void)(value);
    changed();
  };
  return (
    <>
      {current && <Modal key={current.id} req={current} onDone={done} />}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`}>{t.text}</div>
        ))}
      </div>
    </>
  );
}

function Modal({ req, onDone }: { req: Request; onDone: (v: string | boolean | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState(req.kind === "ask" ? req.opts.initial ?? "" : "");
  const [error, setError] = useState<string | null>(null);
  const cancel = req.kind === "ask" ? null : false;

  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (req.kind === "confirm") return onDone(true);
    const err = req.opts.validate?.(value) ?? null;
    if (err) return setError(err);
    onDone(value);
  }

  const { title, ok } = req.opts;
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="modal-title"
      onCancel={(e) => { e.preventDefault(); onDone(cancel); }}
      onClick={(e) => e.target === ref.current && onDone(cancel)}>
      <form onSubmit={submit}>
        <h2 id="modal-title">{title}</h2>
        {req.kind === "confirm" && req.opts.message && <p>{req.opts.message}</p>}
        {req.kind === "ask" && (
          <label className="modal-field">
            {req.opts.label && <span>{req.opts.label}</span>}
            <input autoFocus value={value} placeholder={req.opts.placeholder} aria-invalid={!!error}
              onChange={(e) => { setValue(e.target.value); setError(null); }} />
          </label>
        )}
        {error && <p className="modal-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={() => onDone(cancel)}>{tr("Abbrechen")}</button>
          <button type="submit" autoFocus={req.kind === "confirm"}
            className={req.kind === "confirm" && req.opts.danger ? "danger" : "primary"}>
            {ok ?? (req.kind === "ask" ? tr("OK") : tr("Bestätigen"))}
          </button>
        </div>
      </form>
    </dialog>
  );
}
