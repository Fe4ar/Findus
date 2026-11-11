import { useEffect, useState } from "react";
import { api, NodeDetail } from "../api";
import { confirmDialog } from "../Dialog";
import { tr, dateLocale } from "../i18n";

export interface Revision {
  id: number;
  user: string | null;
  comment: string;
  created_at: string;
}

export function MapHistory({ node, onRestored }: { node: NodeDetail; onRestored: (n: NodeDetail) => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  useEffect(() => {
    api<Revision[]>(`/api/nodes/${node.id}/history`).then(setRevs).catch(() => setRevs([]));
  }, [node.id, node.version]);
  if (!revs) return <p className="muted">{tr("Verlauf wird geladen …")}</p>;
  return (
    <ul className="karte-history">
      {revs.map((r, i) => (
        <li key={r.id}>
          <span>{new Date(r.created_at).toLocaleString(dateLocale())} · {r.user ?? tr("System")}{r.comment && ` · ${r.comment}`}</span>
          {i === 0 ? <span className="muted">{tr("aktuell")}</span> : (
            <button onClick={async () => {
              if (await confirmDialog({ title: tr("Diese Version wiederherstellen?"), message: tr("Die aktuelle bleibt im Verlauf."), ok: tr("Wiederherstellen") }))
                onRestored(await api<NodeDetail>(`/api/nodes/${node.id}/history/${r.id}/restore`, { method: "POST" }));
            }}>{tr("Wiederherstellen")}</button>
          )}
        </li>
      ))}
    </ul>
  );
}
