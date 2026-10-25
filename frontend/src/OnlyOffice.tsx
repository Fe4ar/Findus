import { useEffect, useRef, useState } from "react";
import { api, ApiError, NodeDetail } from "./api";

const OFFICE_EXT = /\.(docx|doc|odt|rtf|xlsx|xls|ods|csv|pptx|ppt|odp)$/;
export const isOffice = (name: string) => OFFICE_EXT.test(name) && !name.endsWith(".csv");

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: object) => { destroyEditor(): void } };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(src: string) {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("OnlyOffice nicht erreichbar"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function OnlyOffice({ node, mode, onClosed }: { node: NodeDetail; mode: "view" | "edit"; onClosed: () => void }) {
  const [error, setError] = useState("");
  const holder = useRef(`oo-${node.id}-${mode}`);

  useEffect(() => {
    let editor: { destroyEditor(): void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { config, api_js } = await api<{ config: object; api_js: string }>(
          `/api/files/${node.id}/onlyoffice-config?mode=${mode}`,
        );
        await loadScript(api_js);
        if (cancelled || !window.DocsAPI) return;
        editor = new window.DocsAPI.DocEditor(holder.current, config);
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e.message
            : "Die Dokumentvorschau konnte nicht geladen werden. Läuft der OnlyOffice-Container?",
        );
      }
    })();
    return () => {
      cancelled = true;
      editor?.destroyEditor();
      if (mode === "edit") onClosed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, mode]);

  if (error)
    return (
      <p className="error">
        {error}{" "}
        <a href="/office/healthcheck" target="_blank" rel="noreferrer">OnlyOffice prüfen</a>
      </p>
    );
  return (
    <div className="oo-frame">
      <div id={holder.current} />
    </div>
  );
}
