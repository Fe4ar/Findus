import { Fragment, useEffect, useRef, useState } from "react";
import { api, Kind } from "./api";
import { navigate } from "./Karte";
import { wantsNewTab } from "./Tabs";
import { tr } from "./i18n";

interface Hit {
  id: string;
  kind: Kind;
  title: string;
  path: string;
  snippet: string;
  group?: string; // "Privat" or the name of the area the hit lives in
}

const KIND_LABEL: Record<string, string> = { area: "Bereich", folder: "Ordner", page: "Seite", file: "Datei", map: "Karte" };

// The server marks hits with \x02…\x03 so no HTML from document text is ever parsed.
function Snippet({ text }: { text: string }) {
  return <>{text.split(/(\x02[^\x03]*\x03)/).map((part, i) =>
    part.startsWith("\x02") ? <mark key={i}>{part.slice(1, -1)}</mark> : part)}</>;
}

// The words of the query, marked in titles the way the server marks them in snippets. Exact mode marks whole words and "quoted phrases" only.
function Title({ text, q, exact }: { text: string; q: string; exact: boolean }) {
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = [...q.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}.-]/gu, "")).filter(Boolean).map(esc).join("\\s+")).filter(Boolean);
  if (!parts.length) return <>{text}</>;
  const re = exact ? new RegExp(`(?<![\\p{L}\\p{N}_])(${parts.join("|")})(?![\\p{L}\\p{N}_])`, "giu") : new RegExp(`(${parts.join("|")})`, "gi");
  return <>{text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

export function Search({ onSelect, onOpenTab, teams = [], hasPrivate = false }: { onSelect: (id: string) => void; onOpenTab?: (path: string) => void; teams?: { id: number; name: string }[]; hasPrivate?: boolean }) {
  const [q, setQ] = useState("");
  const [scopes, setScopes] = useState<string[]>([]); // empty = Alles
  const [exact, setExact] = useState(false); // "Enthält" (stems, prefixes) or "Exakt" (whole words, "phrases")
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const url = `/api/search?q=${encodeURIComponent(q)}${scopes.map((x) => `&scope=${encodeURIComponent(x)}`).join("")}${exact ? "&match=exact" : ""}`;
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let stale = false;
    const t = setTimeout(() => {
      api<Hit[]>(url).then((h) => {
        if (!stale) { setHits(h); setActive(0); }
      });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, scopes, exact]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string) => setScopes((cur) => (id === "all" ? [] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const chips = [{ id: "all", label: tr("Alles") }, ...(hasPrivate ? [{ id: "private", label: tr("Privat") }] : []), ...teams.map((t) => ({ id: `team:${t.id}`, label: t.name }))];

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setHits(null); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const go = (h: Hit, newTab = false) => {
    setHits(null);
    setQ("");
    // map hits carry the query, so the map selects the matching element
    const path = h.kind === "map" ? `/netzwerk/${h.id}?q=${encodeURIComponent(q)}` : h.kind === "link" ? `/netzwerk/${h.id}` : `/n/${h.id}`;
    if (newTab && onOpenTab) onOpenTab(path);
    else if (h.kind === "map" || h.kind === "link") navigate(path);
    else onSelect(h.id);
  };

  return (
    <div className="search" ref={box}>
      <input type="search" placeholder={tr("Suchen …")} aria-label={tr("Volltextsuche")} value={q} role="combobox"
        aria-expanded={!!hits} aria-controls="search-results"
        aria-activedescendant={hits?.length ? `search-hit-${active}` : undefined}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => q.trim() && api<Hit[]>(url).then(setHits)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setHits(null);
          if (!hits?.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
          if (e.key === "Enter") go(hits[active], e.ctrlKey || e.metaKey);
        }} />
      {hits && (
        <div className="search-pop">
          <div className="search-chips">
            {chips.length > 2 && (
              <span className="search-scopes" role="group" aria-label={tr("Suche einschränken")}>
                {chips.map((c) => (
                  <button key={c.id} type="button" className={`chip${(c.id === "all" ? !scopes.length : scopes.includes(c.id)) ? " on" : ""}`}
                    aria-pressed={c.id === "all" ? !scopes.length : scopes.includes(c.id)}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(c.id)}>{c.label}</button>
                ))}
              </span>
            )}
            <span className="search-mode" role="group" aria-label={tr("Trefferart")}>
              <button type="button" aria-pressed={!exact} title={tr("Auch Wortformen und Wortanfänge")} onMouseDown={(e) => e.preventDefault()} onClick={() => setExact(false)}>{tr("Enthält")}</button>
              <button type="button" aria-pressed={exact} title={tr("Nur genau diese Wörter; „in Anführungszeichen“ = Phrase")} onMouseDown={(e) => e.preventDefault()} onClick={() => setExact(true)}>{tr("Exakt")}</button>
            </span>
          </div>
          <ul id="search-results" className="search-results" role="listbox" aria-label={tr("Suchergebnisse")}>
            {hits.length === 0 && <li className="muted">{tr("Keine Treffer.")}</li>}
            {hits.map((h, i) => (
              <Fragment key={h.id}>
                {(i === 0 || hits[i - 1].group !== h.group) && h.group && <li className="search-group" role="presentation">{h.group}</li>}
                <li id={`search-hit-${i}`} role="option" aria-selected={i === active}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h, wantsNewTab(e)); }}>
                  <strong><Title text={h.title} q={q} exact={exact} /></strong>
                  <span className="muted"> · {tr(KIND_LABEL[h.kind] ?? h.kind)}{h.path && ` · ${h.path}`}</span>
                  {h.snippet && <div className="snippet"><Snippet text={h.snippet} /></div>}
                </li>
              </Fragment>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
