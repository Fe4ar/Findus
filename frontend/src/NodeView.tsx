import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor as TipTap } from "@tiptap/react";
import hljs from "highlight.js/lib/common";
import { diffWords, type Change } from "diff";
import { api, ApiError, formatDate, NodeDetail } from "./api";
import { MapLinks } from "./Karte";
import { useDirty } from "./Tabs";
import { Editor } from "./Editor";
import { FileView, uploadFile } from "./FileView";
import { isOffice } from "./OnlyOffice";
import { DocEmbed } from "./DocEmbed";
import { Explorer } from "./Explorer";
import { Rights } from "./Rights";
import { DrawioView, EMPTY_DRAWIO } from "./Drawio";
import { ask, confirmDialog, notify } from "./Dialog";
import { tr } from "./i18n";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Props {
  id: string;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  explorer?: boolean; // classic wiki view: folders and areas show as the explorer
  onTree?: () => void;
  canExport?: boolean;
  incoming?: "team" | "user"; // classic view: top of a team area / the private area also lists what was shared with the team / the user
}

export function NodeView({ id, onSelect, onChanged, explorer, onTree, canExport, incoming }: Props) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"content" | "history">("content");

  useEffect(() => {
    api<NodeDetail>(`/api/nodes/${id}`)
      .then((n) => { setNode(n); if (n.kind === "page") api(`/api/nodes/${id}/view`, { method: "POST" }).catch(() => {}); })
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? tr("Eintrag nicht gefunden.") : tr("Laden fehlgeschlagen.")));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!node) return <p className="muted">{tr("Lade …")}</p>;

  const update = (n: NodeDetail) => {
    setNode(n);
    onChanged();
  };

  return (
    <article className={`node${explorer && node.space === "wiki" && (node.kind === "folder" || node.kind === "area") ? " explorer-mode" : ""}${node.kind === "file" && isOffice(node.versions?.[0]?.original_name.toLowerCase() ?? "") ? " wide-doc" : ""}`}>
      <nav className="breadcrumb" aria-label={tr("Pfad")}>
        {node.breadcrumb.map((b) => (
          <span key={b.id}>
            <a href={`/n/${b.id}`} onClick={(e) => { e.preventDefault(); onSelect(b.id); }}>{b.title}</a>
            <span aria-hidden> / </span>
          </span>
        ))}
        <span aria-current="page">{node.title}</span>
      </nav>
      <div className="node-grid">
        <div className="node-main">
          {(node.kind === "page" || node.kind === "file") && (
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === "content"} onClick={() => setTab("content")}>{tr("Inhalt")}</button>
              <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>{tr("Versionen")}</button>
            </div>
          )}
          {tab === "history" ? (
            <History node={node} onRestored={(n) => { update(n); setTab("content"); }} />
          ) : node.kind === "page" ? (
            <Page node={node} onSaved={update} />
          ) : node.kind === "file" ? (
            <FileView node={node} onChanged={update} />
          ) : explorer && node.space === "wiki" ? (
            <Explorer node={node} onSelect={onSelect} onChanged={onChanged} onTree={onTree} canExport={canExport} incoming={incoming} />
          ) : (
            <Container node={node} onSelect={onSelect} onChanged={onChanged} />
          )}
        </div>
        <Meta node={node} onSaved={update} />
      </div>
    </article>
  );
}

function Container({ node, onSelect, onChanged }: { node: NodeDetail; onSelect: (id: string) => void; onChanged: () => void }) {
  const [children, setChildren] = useState<NodeDetail[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<NodeDetail[]>(`/api/tree?parent=${node.id}`).then(setChildren);
  }, [node.id]);

  async function create(kind: "folder" | "page") {
    const title = await ask(kind === "folder"
      ? { title: tr("Neuer Ordner"), label: tr("Name"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) }
      : { title: tr("Neue Seite"), label: tr("Titel"), ok: tr("Anlegen"), validate: (v) => (v.trim() ? null : tr("Bitte einen Namen eingeben.")) });
    if (!title?.trim()) return;
    try {
      const n = await api<NodeDetail>("/api/nodes", { method: "POST", body: { kind, title: title.trim(), parent: node.id } });
      onChanged();
      onSelect(n.id);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Anlegen fehlgeschlagen."));
    }
  }

  return (
    <section>
      <h1>{node.title}</h1>
      {node.permissions.write && (
        <div className="actions">
          <button onClick={() => create("folder")}>{tr("+ Ordner")}</button>
          <button onClick={() => create("page")}>{tr("+ Seite")}</button>
          <label className="button">
            {busy ? tr("Lade hoch …") : tr("+ Datei hochladen")}
            <input type="file" multiple hidden disabled={busy} onChange={async (e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              setBusy(true);
              try {
                for (const f of files) await uploadFile(node.id, f);
              } catch (err) {
                notify(err instanceof ApiError ? err.message : tr("Upload fehlgeschlagen."));
              }
              setBusy(false);
              onChanged();
              api<NodeDetail[]>(`/api/tree?parent=${node.id}`).then(setChildren);
            }} />
          </label>
        </div>
      )}
      {children?.length === 0 && <p className="muted">{tr("Noch leer.")}</p>}
      <ul className="children">
        {children?.map((c) => (
          <li key={c.id}>
            <a href={`/n/${c.id}`} onClick={(e) => { e.preventDefault(); onSelect(c.id); }}>{c.title}</a>
            <span className="muted"> · {{ area: tr("Bereich"), folder: tr("Ordner"), page: tr("Seite"), file: tr("Datei"), map: tr("Karte"), link: tr("Netzplan") }[c.kind]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Html({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll("pre code").forEach((el) => hljs.highlightElement(el as HTMLElement));
    const roots = [...(ref.current?.querySelectorAll<HTMLElement>("div[data-drawio]") ?? [])]
      .filter((el) => UUID_RE.test(el.dataset.drawio ?? ""))
      .map((el) => {
        const root = createRoot(el);
        root.render(<DrawioView fileId={el.dataset.drawio!} />);
        return root;
      });
    const docs = [...(ref.current?.querySelectorAll<HTMLElement>("div[data-docfile]") ?? [])]
      .filter((el) => UUID_RE.test(el.dataset.docfile ?? ""))
      .map((el) => {
        const root = createRoot(el);
        root.render(<DocEmbed fileId={el.dataset.docfile!} name={el.dataset.docname ?? ""} />);
        return root;
      });
    // Deferred: unmounting a root synchronously while React renders logs a warning.
    return () => [...roots, ...docs].forEach((r) => setTimeout(() => r.unmount()));
  }, [html]);
  // html is sanitized server-side (nh3) before it is stored.
  return <div ref={ref} className="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Page({ node, onSaved }: { node: NodeDetail; onSaved: (n: NodeDetail) => void }) {
  const [editing, setEditing] = useState(false);
  useDirty(editing);
  const [comment, setComment] = useState("");
  const [conflict, setConflict] = useState<NodeDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<TipTap | null>(null);

  async function save() {
    const ed = editorRef.current;
    if (!ed) return;
    setSaving(true);
    try {
      const n = await api<NodeDetail>(`/api/pages/${node.id}/content`, {
        method: "PUT",
        body: { content: ed.getJSON(), html: ed.getHTML(), base_version: node.version, comment },
      });
      setEditing(false);
      setComment("");
      onSaved(n);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(e.body.current);
      else notify(e instanceof ApiError ? e.message : tr("Speichern fehlgeschlagen."));
    }
    setSaving(false);
  }

  async function uploadImage(file: File) {
    if (!node.parent) return null;
    try {
      const n = await uploadFile(node.parent, file, true);
      return n.versions?.[0]?.url ?? null;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Bild-Upload fehlgeschlagen."));
      return null;
    }
  }

  // Embedded documents live in the page's folder like images; the block stores the file node's id.
  async function uploadDoc(file: File) {
    if (!node.parent) return null;
    try {
      return (await uploadFile(node.parent, file, true)).id;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Datei-Upload fehlgeschlagen."));
      return null;
    }
  }

  async function addDiagram() {
    const ref = await ask({ title: tr("Schaubild einfügen"), label: tr("Link oder ID eines vorhandenen .drawio-Schaubilds (leer = neues Schaubild im selben Ordner)"), ok: tr("Einfügen") });
    if (ref === null) return null;
    const id = ref.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
    if (id) return id;
    if (ref.trim()) return notify(tr("Keine gültige Schaubild-ID.")), null;
    if (!node.parent) return null;
    try {
      return (await uploadFile(node.parent, new File([EMPTY_DRAWIO], `${node.title}.drawio`, { type: "application/xml" }))).id;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Schaubild anlegen fehlgeschlagen."));
      return null;
    }
  }

  return (
    <section>
      <header className="page-head">
        <h1>{node.title}</h1>
        <div className="actions">
          {!editing && ["area", "folder", "page"].includes(node.kind) && (
            <span className="export-links">
              {tr("Export:")}{" "}
              <a href={`/api/nodes/${node.id}/export?type=pdf`} download>{tr("PDF")}</a>{" · "}
              <a href={`/api/nodes/${node.id}/export?type=md`} download>{tr("Markdown (ZIP)")}</a>
            </span>
          )}
          {!editing && node.permissions.write && <button className="primary" onClick={() => setEditing(true)}>{tr("Bearbeiten")}</button>}
        </div>
      </header>
      {editing ? (
        <>
          <Editor initial={node.content ?? null} initialHtml={node.content_html ?? ""}
            onReady={(ed) => (editorRef.current = ed)} onImage={uploadImage} onFile={uploadDoc} onDiagram={addDiagram} />
          <div className="save-bar">
            <input placeholder={tr("Kommentar zur Änderung (optional)")} value={comment} onChange={(e) => setComment(e.target.value)}
              aria-label={tr("Kommentar zur Änderung")} />
            <button onClick={() => setEditing(false)} disabled={saving}>{tr("Abbrechen")}</button>
            <button className="primary" onClick={save} disabled={saving}>{saving ? tr("Speichere …") : tr("Speichern")}</button>
          </div>
        </>
      ) : node.content_html ? (
        <Html html={node.content_html} />
      ) : (
        <p className="muted">{tr("Diese Seite ist noch leer.")}</p>
      )}
      {conflict && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-labelledby="conflict-title">
            <h2 id="conflict-title">{tr("Seite wurde inzwischen geändert")}</h2>
            <p>{conflict.updated_by} {tr("hat die Seite am")}{" "}{formatDate(conflict.updated_at)} {tr("gespeichert. Deine Änderungen würden diese überschreiben.")}</p>
            <p>{tr("Kopiere dir bei Bedarf deinen Text, bevor du neu lädst.")}</p>
            <div className="actions">
              <button onClick={() => setConflict(null)}>{tr("Weiter bearbeiten")}</button>
              <button className="primary" onClick={() => { setConflict(null); setEditing(false); onSaved(conflict); }}>
                {tr("Neu laden")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function stripHtml(html: string) {
  const d = document.createElement("div");
  d.innerHTML = html.replace(/<\/(p|h\d|li|tr|pre|blockquote)>/g, "\n");
  return d.textContent ?? "";
}

function History({ node, onRestored }: { node: NodeDetail; onRestored: (n: NodeDetail) => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  const [diff, setDiff] = useState<{ title: string; parts: Change[] } | null>(null);
  useEffect(() => {
    api<any[]>(`/api/nodes/${node.id}/history`).then(setItems);
  }, [node.id, node.version]);
  if (!items) return <p className="muted">{tr("Lade …")}</p>;
  if (!items.length) return <p className="muted">{tr("Noch keine Versionen.")}</p>;

  async function showDiff(i: number) {
    const get = (id: number) => api(`/api/nodes/${node.id}/history/${id}`).then((r: any) => stripHtml(r.content_html));
    const newer = await get(items![i].id);
    const older = i + 1 < items!.length ? await get(items![i + 1].id) : "";
    setDiff({ title: formatDate(items![i].created_at), parts: diffWords(older, newer) });
  }

  return (
    <section>
      <table className="history">
        <thead>
          <tr><th>{tr("Datum")}</th><th>{tr("Von")}</th><th>{tr("Kommentar")}</th><th /></tr>
        </thead>
        <tbody>
          {items.map((v, i) => (
            <tr key={v.id}>
              <td>{formatDate(v.created_at)}</td>
              <td>{v.user ?? "–"}</td>
              <td>{v.comment || (v.source === "onlyoffice" ? tr("Bearbeitet in OnlyOffice") : v.original_name) || "–"}</td>
              <td className="actions">
                {node.kind === "page" ? (
                  <>
                    <button onClick={() => showDiff(i)}>{tr("Änderungen")}</button>
                    {i > 0 && node.permissions.write && (
                      <button onClick={async () => {
                        if (await confirmDialog({ title: tr("Diesen Stand wiederherstellen?"), message: tr("Er wird als neue Version gespeichert, der aktuelle Stand bleibt im Verlauf."), ok: tr("Wiederherstellen") }))
                          onRestored(await api(`/api/nodes/${node.id}/history/${v.id}/restore`, { method: "POST" }));
                      }}>{tr("Wiederherstellen")}</button>
                    )}
                  </>
                ) : (
                  <>
                    <a className="button" href={`${v.url}?download=1`}>{tr("Herunterladen")}</a>
                    {i > 0 && node.permissions.write && (
                      <button onClick={async () => {
                        if (await confirmDialog({ title: tr("Diese Fassung wiederherstellen?"), message: tr("Sie wird als neue Version gespeichert, die aktuelle bleibt im Verlauf."), ok: tr("Wiederherstellen") }))
                          onRestored(await api(`/api/files/${node.id}/versions/${v.id}/restore`, { method: "POST" }));
                      }}>{tr("Wiederherstellen")}</button>
                    )}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {diff && (
        <div className="diff">
          <h3>{tr("Änderungen der Version vom")}{" "}{diff.title}</h3>
          <pre>
            {diff.parts.map((p, i) => (
              <span key={i} className={p.added ? "add" : p.removed ? "del" : ""}>{p.value}</span>
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}

function Meta({ node, onSaved }: { node: NodeDetail; onSaved: (n: NodeDetail) => void }) {
  const [editing, setEditing] = useState(false);
  useDirty(editing);
  const [title, setTitle] = useState(node.title);
  const [description, setDescription] = useState(node.description);
  const [tags, setTags] = useState(node.tags.join(", "));

  async function patch(body: object) {
    try {
      onSaved(await api(`/api/nodes/${node.id}`, { method: "PATCH", body }));
      return true;
    } catch (e) {
      notify(e instanceof ApiError ? e.message : tr("Speichern fehlgeschlagen."));
      return false;
    }
  }

  return (
    <aside className="meta" aria-label={tr("Eigenschaften")}>
      {editing ? (
        <form onSubmit={async (e) => {
          e.preventDefault();
          if (await patch({ title, description, tags: tags.split(",") })) setEditing(false);
        }}>
          <label>{tr("Titel")}<input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
          <label>{tr("Beschreibung")}<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <label>{tr("Tags (mit Komma getrennt)")}<input value={tags} onChange={(e) => setTags(e.target.value)} /></label>
          <div className="actions">
            <button type="button" onClick={() => setEditing(false)}>{tr("Abbrechen")}</button>
            <button type="submit" className="primary">{tr("Speichern")}</button>
          </div>
        </form>
      ) : (
        <dl>
          {node.description && (<><dt>{tr("Beschreibung")}</dt><dd>{node.description}</dd></>)}
          {node.tags.length > 0 && (<><dt>{tr("Tags")}</dt><dd>{node.tags.map((t) => <span key={t} className="tag">{t}</span>)}</dd></>)}
          <dt>{tr("Erstellt")}</dt><dd>{node.created_by ?? "–"}, {formatDate(node.created_at)}</dd>
          <dt>{tr("Zuletzt geändert")}</dt><dd>{node.updated_by ?? "–"}, {formatDate(node.updated_at)}</dd>
          {(node.kind === "page" || node.kind === "file") && (
            <>
              <dt>{tr("Status")}</dt>
              <dd>
                {node.permissions.publish ? (
                  <select aria-label={tr("Status")} value={node.status} onChange={(e) => patch({ status: e.target.value })}>
                    <option value="draft">{tr("Entwurf")}</option>
                    <option value="published">{tr("Veröffentlicht")}</option>
                  </select>
                ) : node.status === "draft" ? tr("Entwurf") : tr("Veröffentlicht")}
              </dd>
            </>
          )}
        </dl>
      )}
      {!editing && node.permissions.write && <button onClick={() => setEditing(true)}>{tr("Eigenschaften bearbeiten")}</button>}
      {!editing && <MapLinks id={node.id} />}
      {!editing && <Rights node={node} onSaved={onSaved} />}
    </aside>
  );
}
