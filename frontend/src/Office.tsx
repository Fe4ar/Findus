import { useEffect, useRef, useState } from "react";
import { api, ApiError, Me, NodeDetail } from "./api";
import { Icon } from "./Icons";
import { tr } from "./i18n";

let meCache: Promise<Me> | null = null;
/** Whether Collabora is set up on this server (cached; the answer does not change while the page is open). */
export const useCollabora = () => {
  const [on, setOn] = useState(false);
  useEffect(() => { (meCache ??= api<Me>("/api/auth/me")).then((m) => setOn(!!m.collabora)).catch(() => undefined); }, []);
  return on;
};

/** Pill with a sliding marker: Ansehen / Bearbeiten. Bearbeiten is greyed out without write right. */
export function ModeSwitch({ mode, onChange, canEdit }: { mode: "view" | "edit"; onChange: (m: "view" | "edit") => void; canEdit: boolean }) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label={tr("Ansicht")} data-mode={mode}>
      <span className="mode-thumb" aria-hidden="true" />
      <button role="radio" aria-checked={mode === "view"} onClick={() => onChange("view")}><Icon name="eye" size={16} /> {tr("Ansehen")}</button>
      <button role="radio" aria-checked={mode === "edit"} disabled={!canEdit} onClick={() => onChange("edit")}
        title={canEdit ? undefined : tr("Du hast hier nur Leserechte.")}><Icon name="pen" size={16} /> {tr("Bearbeiten")}</button>
    </div>
  );
}

/** Collabora Online in an iframe: the browser posts the access token to the editor URL Findus hands out. */
export function Collabora({ node, mode }: { node: NodeDetail; mode: "view" | "edit" }) {
  const [cfg, setCfg] = useState<{ url: string; token: string; ttl: number } | null>(null);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const name = `collabora-${node.id}-${mode}`;
  useEffect(() => {
    api<{ url: string; token: string; ttl: number }>(`/api/files/${node.id}/collabora?mode=${mode}`).then(setCfg)
      .catch((e) => setError(e instanceof ApiError ? e.message : tr("Collabora konnte nicht geladen werden.")));
  }, [node.id, mode]);
  useEffect(() => { if (cfg) form.current?.submit(); }, [cfg]);
  if (error) return <p className="error" role="alert">{error}</p>;
  return (
    <div className="oo-frame">
      {cfg && (
        <form ref={form} action={cfg.url} method="post" target={name} hidden>
          <input name="access_token" value={cfg.token} readOnly /><input name="access_token_ttl" value={cfg.ttl} readOnly />
        </form>
      )}
      <iframe name={name} title={node.title} className="collabora-frame" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
  );
}
