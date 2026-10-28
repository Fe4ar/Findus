import { useEffect, useRef, useState } from "react";
import { api } from "./api";

// Landing page of the public FAQ: one big search box with suggestions, the most read posts as tiles, then the categories.
interface Hit { id: string; kind: string; title: string; path: string; snippet: string }
interface Landing {
  ticket: { url: string; label: string } | null;
  top: { id: string; title: string; views: number; category: string }[];
  categories: { id: string; title: string; pages: { id: string; title: string }[]; more: number }[];
}

function Snippet({ text }: { text: string }) {
  return <>{text.split(/(\x02[^\x03]*\x03)/).map((part, i) => (part.startsWith("\x02") ? <mark key={i}>{part.slice(1, -1)}</mark> : part))}</>;
}

export function Faq({ onSelect }: { onSelect: (id: string) => void }) {
  const [data, setData] = useState<Landing | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { api<Landing>("/api/faq").then(setData).catch(() => setData({ ticket: null, top: [], categories: [] })); }, []);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let stale = false;
    const t = setTimeout(() => api<Hit[]>(`/api/search?faq=1&q=${encodeURIComponent(q)}`).then((h) => { if (!stale) { setHits(h.filter((x) => x.kind === "page")); setActive(0); } }), 200);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);
  // {q} in the configured address is replaced by the search term; the server only stores http/https addresses.
  const ticketHref = (term: string) => (data?.ticket ? data.ticket.url.replace(/\{q\}/g, encodeURIComponent(term)) : "");
  const link = (id: string, title: string, extra?: JSX.Element) => (
    <a href={`/n/${id}`} onClick={(e) => { e.preventDefault(); onSelect(id); }}>{title}{extra}</a>
  );
  return (
    <div className="faq">
      <section className="faq-hero">
        <h1>Wie können wir helfen?</h1>
        <div className="faq-search" ref={box}>
          <input type="search" placeholder="Frage oder Stichwort eingeben …" aria-label="FAQ durchsuchen" value={q} role="combobox" aria-expanded={!!hits}
            aria-controls="faq-results" onChange={(e) => setQ(e.target.value)} autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") setHits(null);
              if (!hits?.length) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
              if (e.key === "Enter") onSelect(hits[active].id);
            }} />
          {hits && (
            <ul id="faq-results" className="faq-suggest" role="listbox">
              {!hits.length && (
                <li className="faq-none"><span className="muted">Keine Treffer.</span>
                  {data?.ticket && <a className="button primary" href={ticketHref(q)} target="_blank" rel="noopener noreferrer">Nichts gefunden? {data.ticket.label}</a>}</li>
              )}
              {hits.slice(0, 8).map((h, i) => (
                <li key={h.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); onSelect(h.id); }}>
                  <strong>{h.title}</strong>{h.snippet && <div className="snippet"><Snippet text={h.snippet} /></div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      {data && data.top.length > 0 && (
        <section>
          <h2>Meistgelesen</h2>
          <ul className="faq-tiles">
            {data.top.map((t) => <li key={t.id}>{link(t.id, t.title, <small>{t.category}</small>)}</li>)}
          </ul>
        </section>
      )}
      {data && data.categories.length > 0 && (
        <section>
          <h2>Kategorien</h2>
          <div className="faq-cats">
            {data.categories.map((c) => (
              <article key={c.id}>
                <h3>{c.title}</h3>
                <ul>{c.pages.map((p) => <li key={p.id}>{link(p.id, p.title)}</li>)}</ul>
                {c.more > 0 && <p className="muted small">und {c.more} weitere …</p>}
              </article>
            ))}
          </div>
        </section>
      )}
      {data?.ticket && (
        <p className="faq-ticket muted">Keine Antwort gefunden? <a href={ticketHref(q)} target="_blank" rel="noopener noreferrer">{data.ticket.label}</a></p>
      )}
    </div>
  );
}
