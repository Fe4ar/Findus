import { useEffect, useRef, useState } from "react";
import { api, Kind } from "./api";
import { navigate } from "./Karte";

interface Hit {
  id: string;
  kind: Kind;
  title: string;
  path: string;
  snippet: string;
}

const KIND_LABEL: Record<string, string> = { area: "Bereich", folder: "Ordner", page: "Seite", file: "Datei", map: "Karte" };

// The server marks hits with \x02…\x03 so no HTML from document text is ever parsed.
function Snippet({ text }: { text: string }) {
  return <>{text.split(/(\x02[^\x03]*\x03)/).map((part, i) =>
    part.startsWith("\x02") ? <mark key={i}>{part.slice(1, -1)}</mark> : part)}</>;
}

export function Search({ onSelect }: { onSelect: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let stale = false;
    const t = setTimeout(() => {
      api<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`).then((h) => {
        if (!stale) { setHits(h); setActive(0); }
      });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setHits(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const go = (h: Hit) => {
    setHits(null);
    setQ("");
    if (h.kind === "map" || h.kind === "link") navigate(`/netzwerk/${h.id}`);
    else onSelect(h.id);
  };

  return (
    <div className="search" ref={box}>
      <input type="search" placeholder="Suchen …" aria-label="Volltextsuche" value={q} role="combobox"
        aria-expanded={!!hits} aria-controls="search-results"
        aria-activedescendant={hits?.length ? `search-hit-${active}` : undefined}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => q.trim() && api<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`).then(setHits)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setHits(null);
          if (!hits?.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
          if (e.key === "Enter") go(hits[active]);
        }} />
      {hits && (
        <ul id="search-results" className="search-results" role="listbox" aria-label="Suchergebnisse">
          {hits.length === 0 && <li className="muted">Keine Treffer.</li>}
          {hits.map((h, i) => (
            <li key={h.id} id={`search-hit-${i}`} role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h); }}>
              <strong>{h.title}</strong>
              <span className="muted"> · {KIND_LABEL[h.kind] ?? h.kind}{h.path && ` · ${h.path}`}</span>
              {h.snippet && <div className="snippet"><Snippet text={h.snippet} /></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
