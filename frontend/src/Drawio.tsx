import { useEffect, useRef, useState } from "react";
import { api, ApiError, NodeDetail } from "./api";
import { useDirty } from "./Tabs";
import { notify } from "./Dialog";
import { tr } from "./i18n";

// Self-hosted draw.io (container "drawio", Caddy path /drawio/ of the same host, so it also works behind NPM).
// stealth=1 turns off every feature that calls external services.
const DRAWIO = `${location.origin}/drawio/`;
const PARAMS = "embed=1&proto=json&configure=1&spin=1&stealth=1&lang=de&libraries=1";
export const EMPTY_DRAWIO = '<mxfile><diagram name="Seite-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export async function saveDrawio(fileId: string, xml: string, name: string) {
  const form = new FormData();
  form.append("file", new File([xml], name, { type: "application/xml" }));
  return api<NodeDetail>(`/api/files/${fileId}/versions`, { method: "POST", body: form });
}

/** Shows a .drawio file node read-only; "Bearbeiten" opens the full editor, every save is a new file version. */
export function DrawioView({ fileId }: { fileId: string }) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  useDirty(editing);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let alive = true;
    api<NodeDetail>(`/api/nodes/${fileId}`)
      .then(async (n) => {
        const v = n.versions?.[0];
        if (!v) throw new Error(tr("Schaubild hat keine Version."));
        const text = await (await fetch(v.url, { credentials: "same-origin" })).text();
        if (alive) { setNode(n); setXml(text); }
      })
      .catch((e) => alive && setError(e instanceof ApiError && e.status === 404 ? tr("Schaubild nicht gefunden.") : e.message));
    return () => { alive = false; };
  }, [fileId]);

  useEffect(() => {
    if (xml === null) return;
    // The sandboxed frame has an opaque origin ("null"), so target "*"; only that frame's window receives it.
    const post = (msg: object) => frame.current?.contentWindow?.postMessage(JSON.stringify(msg), "*");
    const onMessage = async (ev: MessageEvent) => {
      if (ev.source !== frame.current?.contentWindow || ev.origin !== "null") return;
      const msg = JSON.parse(ev.data);
      // Uncompressed XML keeps the labels readable for the full-text search.
      if (msg.event === "configure") post({ action: "configure", config: { compressXml: false } });
      else if (msg.event === "init") post({ action: "load", xml, autosave: 0 });
      else if (msg.event === "save" && node) {
        try {
          const n = await saveDrawio(node.id, msg.xml, node.versions?.[0]?.original_name ?? node.title);
          setNode(n);
          setXml(msg.xml);
          post({ action: "status", message: tr("Gespeichert"), modified: false });
          if (msg.exit) setEditing(false);
        } catch (e) {
          notify(e instanceof ApiError ? e.message : tr("Speichern fehlgeschlagen."));
        }
      } else if (msg.event === "exit") setEditing(false);
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [xml, node]);

  // The static demo has no draw.io server behind it.
  if (import.meta.env.VITE_DEMO) return <p className="muted">Schaubild „{node?.title ?? ""}“: draw.io ist in der statischen Demo nicht enthalten.</p>;
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!node || xml === null) return <p className="muted">{tr("Lade Schaubild …")}</p>;
  const src = DRAWIO + "?" + PARAMS + (editing ? "&saveAndExit=1&noSaveBtn=0" : "&chrome=0&nav=1&toolbar=zoom");
  return (
    <figure className={editing ? "drawio editing" : "drawio"}>
      {/* Same host as Findus since /drawio/, so the sandbox (no allow-same-origin) keeps draw.io away from the Findus session. */}
      <iframe key={String(editing)} ref={frame} src={src} title={tr("Schaubild {title}", { title: node.title })}
        sandbox="allow-scripts allow-popups allow-downloads allow-modals allow-forms" />
      <figcaption className="actions">
        <a href={`/n/${node.id}`} className="muted">{node.title}</a>
        {!editing && node.permissions.write && <button onClick={() => setEditing(true)}>{tr("Bearbeiten")}</button>}
      </figcaption>
    </figure>
  );
}
