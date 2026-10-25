import { useEffect, useState } from "react";
import { api, NodeDetail, NodeSummary } from "../api";
import { Rights } from "../Rights";
import { DrawioView } from "../Drawio";
import { navigate } from "./model";
import { MapView } from "./MapView";

/** Backlinks on a wiki page: map elements and network-plan shortcuts that point at it. */
export function MapLinks({ id }: { id: string }) {
  const [maps, setMaps] = useState<{ id: string; kind: string; title: string; elements: { id: string; name: string }[] }[]>([]);
  useEffect(() => {
    api<typeof maps>(`/api/nodes/${id}/maps`).then(setMaps).catch(() => setMaps([]));
  }, [id]);
  if (!maps.length) return null;
  return (
    <div className="karte-links">
      <h3>Im Reiter Netzwerk</h3>
      <ul>
        {maps.flatMap((m) => (m.kind === "link" ? [{ id: "", name: "" }] : m.elements).map((e) => {
          const href = `/netzwerk/${m.id}${e.id ? `?el=${encodeURIComponent(e.id)}` : ""}`;
          return (
            <li key={`${m.id}-${e.id}`}>
              <a href={href} onClick={(ev) => { ev.preventDefault(); navigate(href); }}>
                {m.kind === "link" ? `📐 Netzplan „${m.title}“ öffnen` : `🗺️ ${m.title}: ${e.name}`}
              </a>
            </li>
          );
        }))}
      </ul>
    </div>
  );
}

/** Network tab content: a map, or a shortcut that shows its .drawio plan from the wiki (single source). */
export function NetView({ id, onChanged, search }: { id: string; onChanged: () => void; search?: string }) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [children, setChildren] = useState<NodeSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<NodeDetail>(`/api/nodes/${id}`).then((n) => {
      setNode(n);
      if (n.kind === "area" || n.kind === "folder") api<NodeSummary[]>(`/api/tree?parent=${id}`).then(setChildren);
    }).catch(() => setError("Eintrag konnte nicht geladen werden."));
  }, [id]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!node) return <p className="muted">Wird geladen …</p>;
  if (node.kind === "map") return <MapView id={id} onChanged={onChanged} search={search} />;
  if (node.kind === "link") {
    return (
      <div className="karte">
        <h1>📐 {node.title}</h1>
        {node.target ? <DrawioView fileId={node.target} /> : <p className="error" role="alert">Der verknüpfte Netzplan wurde im Wiki gelöscht.</p>}
      </div>
    );
  }
  return (
    <div className="node-grid">
      <div>
        <p className="muted">{node.kind === "area" ? "Bereich" : "Ordner"}</p>
        <h1>{node.title}</h1>
        {children.length ? (
          <ul className="children">
            {children.map((c) => (
              <li key={c.id}>
                <a href={`/netzwerk/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/netzwerk/${c.id}`); }}>
                  {{ folder: "📁", map: "🗺️", link: "📐" }[c.kind as string] ?? "▣"} {c.title}
                </a>
                <span className="muted"> · {{ folder: "Ordner", map: "Karte", link: "Netzplan" }[c.kind as string] ?? ""}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">Noch leer.</p>}
        <p className="muted">Rechtsklick links im Baum legt Ordner, Karten oder Netzplan-Verknüpfungen an.</p>
      </div>
      {node.permissions.manage && <aside className="meta" aria-label="Eigenschaften"><Rights node={node} onSaved={setNode} /></aside>}
    </div>
  );
}
