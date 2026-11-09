import { FormEvent, useEffect, useRef, useState } from "react";
import { api, ApiError, Me } from "./api";

/** Old password once, new password twice. Shared by the profile menu and by the start admin's forced change. */
function Fields({ forced, onDone }: { forced: boolean; onDone: (me: Me) => void }) {
  const [old, setOld] = useState("");
  const [fresh, setFresh] = useState("");
  const [again, setAgain] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setBusy(true);
    try {
      onDone(await api<Me>("/api/auth/password", { method: "POST", body: { old, new: fresh, new2: again } }));
    } catch (x) {
      const body = x instanceof ApiError ? (x.body as Record<string, unknown> | undefined) : undefined;
      const pick = (k: string) => { const v = body?.[k]; return Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : ""; };
      const found = { old: pick("old"), new: pick("new"), new2: pick("new2") };
      setErrors(found.old || found.new || found.new2 ? found : { form: x instanceof ApiError ? x.message : "Passwort konnte nicht geändert werden." });
    } finally { setBusy(false); }
  };
  const field = (label: string, value: string, set: (v: string) => void, key: string, auto: string, first = false) => (
    <label>{label}
      <input type="password" value={value} onChange={(e) => set(e.target.value)} autoComplete={auto} autoFocus={first} required
        aria-invalid={!!errors[key]} aria-describedby={errors[key] ? `pw-err-${key}` : undefined} />
      {errors[key] && <span className="error" id={`pw-err-${key}`} role="alert">{errors[key]}</span>}
    </label>
  );
  return (
    <form onSubmit={submit} className="password-form">
      {forced && <p className="muted">Du bist mit dem Startpasswort angemeldet. Lege jetzt ein eigenes Passwort fest; erst danach geht es weiter.</p>}
      {field(forced ? "Startpasswort" : "Bisheriges Passwort", old, setOld, "old", "current-password", true)}
      {field("Neues Passwort", fresh, setFresh, "new", "new-password")}
      {field("Neues Passwort wiederholen", again, setAgain, "new2", "new-password")}
      {errors.form && <p className="error" role="alert">{errors.form}</p>}
      <button type="submit" className="primary" disabled={busy || !old || !fresh || !again}>{forced ? "Passwort festlegen" : "Passwort ändern"}</button>
    </form>
  );
}

/** The start admin: nothing else is reachable until a new password is set. */
export function ForcedPassword({ onDone, onLogout }: { onDone: (me: Me) => void; onLogout: () => void }) {
  return (
    <main className="login">
      <div className="password-forced">
        <h1><img src="/findus.svg" alt="" />Neues Passwort festlegen</h1>
        <Fields forced onDone={onDone} />
        <p><button type="button" className="link" onClick={onLogout}>Abmelden</button></p>
      </div>
    </main>
  );
}

/** "Passwort ändern" in the profile menu. */
export function PasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: (me: Me) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="pw-title" onClose={onClose}>
      <h2 id="pw-title">Passwort ändern</h2>
      {saved ? <p role="status">Dein Passwort wurde geändert.</p> : <Fields forced={false} onDone={(m) => { setSaved(true); onDone(m); }} />}
      <div className="actions"><span className="spacer" /><button onClick={() => ref.current?.close()}>{saved ? "Schließen" : "Abbrechen"}</button></div>
    </dialog>
  );
}
