import { useEffect, useState } from "react";
import { api, formatSize, NodeDetail } from "./api";
import { Icon } from "./Icons";
import { OnlyOffice, isOffice } from "./OnlyOffice";
import { Collabora, useCollabora } from "./Office";
import { tr } from "./i18n";

/** A file embedded in a page: a collapsed block; opened, an Office document is edited right there (view only without write right). */
export function DocEmbed({ fileId, name }: { fileId: string; name: string }) {
  const [node, setNode] = useState<NodeDetail | null | false>(null); // false = not available for this reader
  const [open, setOpen] = useState(false);
  const collabora = useCollabora();
  const load = () => api<NodeDetail>(`/api/nodes/${fileId}`).then(setNode).catch(() => setNode(false));
  useEffect(() => { load(); }, [fileId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (node === null) return <div className="doc-embed muted">{tr("Lade …")}</div>;
  if (node === false) return <div className="doc-embed muted"><Icon name="fileText" size={16} /> {name || tr("Dokument")} {tr("(nicht verfügbar)")}</div>;
  const v = node.versions?.[0];
  const title = v?.original_name ?? node.title;
  const mode = node.permissions.write ? "edit" : "view";
  const lower = title.toLowerCase();
  let body = null;
  if (open && v) {
    if (isOffice(lower)) {
      body = collabora
        ? <Collabora key={`${v.id}-${mode}`} node={node} mode={mode} />
        : <OnlyOffice key={`${v.id}-${mode}`} node={node} mode={mode} onClosed={load} />;
    } else if (v.mime === "application/pdf") body = <iframe className="pdf" src={v.url} title={title} />;
    else if (v.mime.startsWith("image/") && v.mime !== "image/svg+xml") body = <img className="image-preview" src={v.url} alt={title} />;
    else body = <p className="muted">{tr("Für diesen Dateityp gibt es keine Vorschau, du kannst ihn herunterladen.")}</p>;
  }
  return (
    <div className={`doc-embed${open ? " open" : ""}`}>
      <div className="doc-embed-head">
        <button type="button" className="doc-embed-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={14} /><Icon name="fileText" size={16} />
          <strong>{title}</strong>{v && <small className="muted">{formatSize(v.size)}</small>}
          <span className="muted">{open ? tr("Zuklappen") : isOffice(lower) && mode === "edit" ? tr("Aufklappen und bearbeiten") : tr("Aufklappen")}</span>
        </button>
        {v && <a className="button" href={`${v.url}?download=1`}>{tr("Herunterladen")}</a>}
      </div>
      {body}
    </div>
  );
}
