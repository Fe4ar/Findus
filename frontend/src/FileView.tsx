import { useEffect, useState } from "react";
import { api, ApiError, formatSize, NodeDetail } from "./api";
import { OnlyOffice, isOffice } from "./OnlyOffice";
import { DrawioView } from "./Drawio";
import { ask, notify } from "./Dialog";
import { Collabora, ModeSwitch, useCollabora } from "./Office";
import { tr } from "./i18n";

/** attachment = pasted image / embedded document: the file belongs to a page and stays out of the tree. */
export async function uploadFile(parent: string, file: File, attachment = false) {
  const form = new FormData();
  form.append("parent", parent);
  form.append("file", file);
  if (attachment) form.append("attachment", "1");
  return api<NodeDetail>("/api/files", { method: "POST", body: form });
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    fetch(url, { credentials: "same-origin" }).then((r) => r.text()).then((t) => setText(t.slice(0, 500_000)));
  }, [url]);
  return text === null ? <p className="muted">{tr("Lade …")}</p> : <pre className="text-preview">{text}</pre>;
}

export function FileView({ node, onChanged }: { node: NodeDetail; onChanged: (n: NodeDetail) => void }) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [busy, setBusy] = useState(false);
  const collabora = useCollabora();
  const v = node.versions?.[0];
  if (!v) return <p className="muted">{tr("Keine Datei vorhanden.")}</p>;

  const name = v.original_name.toLowerCase();
  let preview;
  if (name.endsWith(".drawio")) preview = <DrawioView key={v.id} fileId={node.id} />;
  else if (isOffice(name) && collabora) preview = <Collabora key={`${v.id}-${mode}`} node={node} mode={mode} />;
  else if (isOffice(name)) preview = <OnlyOffice key={`${v.id}-${mode}`} node={node} mode={mode} onClosed={() => {
    setMode("view");
    api<NodeDetail>(`/api/nodes/${node.id}`).then(onChanged);
  }} />;
  else if (v.mime === "application/pdf") preview = <iframe className="pdf" src={v.url} title={v.original_name} />;
  else if (v.mime.startsWith("image/") && v.mime !== "image/svg+xml") preview = <img className="image-preview" src={v.url} alt={v.original_name} />;
  else if (v.mime.startsWith("text/") || /\.(md|txt|log|csv|json|ya?ml|conf|ini|sh|py)$/.test(name)) preview = <TextPreview url={v.url} />;
  else preview = <p className="muted">{tr("Für diesen Dateityp gibt es keine Vorschau.")}</p>;

  return (
    <section>
      <header className="page-head">
        <h1>{node.title}</h1>
        <div className="actions">
          {isOffice(name) && (
            <ModeSwitch mode={mode} canEdit={!!node.permissions.write} onChange={(m) => {
              setMode(m);
              // Collabora saves through WOPI on its own; reload the version list a moment after leaving edit mode.
              if (m === "view" && collabora) setTimeout(() => api<NodeDetail>(`/api/nodes/${node.id}`).then(onChanged), 1500);
            }} />
          )}
          <a className="button" href={`${v.url}?download=1`}>{tr("Herunterladen")}</a>
          {node.permissions.write && (
            <label className="button">
              {busy ? tr("Lade hoch …") : tr("Neue Version hochladen")}
              <input type="file" hidden disabled={busy} onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const comment = await ask({ title: tr("Neue Version hochladen"), label: tr("Kommentar (optional)"), ok: tr("Hochladen") });
                if (comment === null) return;
                const form = new FormData();
                form.append("file", file);
                form.append("comment", comment);
                setBusy(true);
                try {
                  onChanged(await api(`/api/files/${node.id}/versions`, { method: "POST", body: form }));
                } catch (err) {
                  notify(err instanceof ApiError ? err.message : tr("Upload fehlgeschlagen."));
                }
                setBusy(false);
              }} />
            </label>
          )}
        </div>
      </header>
      <p className="muted">{v.original_name} · {formatSize(v.size)}</p>
      {preview}
    </section>
  );
}
