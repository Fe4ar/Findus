import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import "./hilfe.css";
import { tr, dateLocale, useLang, setLang, getLang, LANGS } from "../i18n";

// Help portal for people without an account: only the public FAQ, read-only, own entry point (/hilfe/).
// It talks to /api/public/* and nothing else; no login, no cookies, no link into the internal app.

interface Hit { id: string; title: string; path: string; snippet: string }
interface Row { id: string; title: string; views: number; category: string }
interface Landing {
  ticket: { url: string; label: string } | null;
  top: Row[];
  recent: Row[];
  categories: { id: string; title: string; pages: { id: string; title: string }[]; more: number }[];
}
interface Page { id: string; title: string; content_html: string; updated_at: string; breadcrumb: { id: string; title: string }[]; ticket: Landing["ticket"] }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "omit" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Links between FAQ pages are /n/<id> in the app; in the portal they point to /hilfe/?p=<id> (no internal path is exposed).
const portalLinks = (html: string) => html.replace(/href="\/n\/([0-9a-f-]{36})[^"]*"/g, 'href="/hilfe/?p=$1"');

// "Zuletzt angesehen": only page ids, kept in this browser (localStorage); the server never learns who read what.
const SEEN_KEY = "findus-hilfe-seen";
const readSeen = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^[0-9a-f-]{36}$/.test(x)).slice(0, 12) : [];
  } catch { return []; }
};
const writeSeen = (ids: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(0, 12))); } catch { /* storage blocked: no history */ } };
const remember = (id: string) => writeSeen([id, ...readSeen().filter((x) => x !== id)]);

const pageHref = (id: string) => `/hilfe/?p=${id}`;
const currentPage = () => new URLSearchParams(location.search).get("p");

function Snippet({ text }: { text: string }) {
  return <>{text.split(/(\x02[^\x03]*\x03)/).map((part, i) => (part.startsWith("\x02") ? <mark key={i}>{part.slice(1, -1)}</mark> : part))}</>;
}

/** "Problem nicht gelöst? Ticket schreiben": opens the ticket system set in the administration in a new tab; nothing without a link. */
function TicketCard({ ticket, term }: { ticket: Landing["ticket"]; term: string }) {
  if (!ticket) return null;
  // {q} in the configured address is replaced by the search term or the page title; the server only stores http/https addresses.
  return (
    <aside className="hilfe-ticket" aria-label={tr("Ticket schreiben")}>
      <div>
        <strong>{tr("Problem nicht gelöst? Ticket schreiben")}</strong>
        <p className="muted">{tr("Hat die Antwort nicht geholfen? Schreib uns ein Ticket, wir kümmern uns darum.")}</p>
      </div>
      <a className="button primary" href={ticket.url.replace(/\{q\}/g, encodeURIComponent(term))} target="_blank" rel="noopener noreferrer">{ticket.label}</a>
    </aside>
  );
}

function Portal() {
  useLang(); // the portal is public: visitors choose the language here (remembered in the browser)
  const [id, setId] = useState(currentPage());
  useEffect(() => {
    const onPop = () => setId(currentPage());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const open = (to: string | null) => {
    history.pushState(null, "", to ? pageHref(to) : "/hilfe/");
    setId(to);
    scrollTo(0, 0);
  };
  return (
    <div className="hilfe">
      <header className="hilfe-bar"><a href="/hilfe/" onClick={(e) => { e.preventDefault(); open(null); }}><img src="/findus.svg" alt="" width={28} height={28} />{tr("Hilfe")}</a><span className="spacer" /><span className="hilfe-lang">{LANGS.map(({ code, name }, k) => <span key={code}>{k > 0 && " · "}<button type="button" className="link" aria-pressed={getLang() === code} onClick={() => setLang(code)}>{name}</button></span>)}</span></header>
      <main>{id ? <Article id={id} open={open} /> : <Start open={open} />}</main>
    </div>
  );
}

function Start({ open }: { open: (id: string) => void }) {
  const [data, setData] = useState<Landing | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const [seen, setSeen] = useState<Row[]>([]);
  useEffect(() => {
    const ids = readSeen();
    if (!ids.length) return;
    get<Row[]>(`/api/public/titles?ids=${ids.join(",")}`).then((rows) => { writeSeen(rows.map((r) => r.id)); setSeen(rows.slice(0, 6)); }).catch(() => undefined);
  }, []);
  useEffect(() => { document.title = tr("Hilfe"); get<Landing>("/api/public/faq").then(setData).catch(() => setData({ ticket: null, top: [], recent: [], categories: [] })); }, []);
  useEffect(() => {
    if (!q.trim()) return setHits(null);
    let stale = false;
    const t = setTimeout(() => get<Hit[]>(`/api/public/search?q=${encodeURIComponent(q)}`).then((h) => { if (!stale) { setHits(h); setActive(0); } }).catch(() => undefined), 200);
    return () => { stale = true; clearTimeout(t); };
  }, [q]);
  const ticket = (term: string) => (data?.ticket ? data.ticket.url.replace(/\{q\}/g, encodeURIComponent(term)) : "");
  const link = (id: string, title: string, extra?: JSX.Element) => <a href={pageHref(id)} onClick={(e) => { e.preventDefault(); open(id); }}>{title}{extra}</a>;
  return (
    <>
      <section className="faq-hero hilfe-hero">
        <h1>{tr("Wie können wir helfen?")}</h1>
        <div className="faq-search">
          <input type="search" placeholder={tr("Frage oder Stichwort eingeben …")} aria-label={tr("Hilfe durchsuchen")} value={q} role="combobox" aria-expanded={!!hits}
            aria-controls="hilfe-results" onChange={(e) => setQ(e.target.value)} autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") setHits(null);
              if (!hits?.length) return;
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
              if (e.key === "Enter") open(hits[active].id);
            }} />
          {hits && (
            <ul id="hilfe-results" className="faq-suggest" role="listbox">
              {!hits.length && (
                <li className="faq-none"><span className="muted">{tr("Keine Treffer.")}</span>
                  {data?.ticket && <a className="button primary" href={ticket(q)} target="_blank" rel="noopener noreferrer">{tr("Nichts gefunden?")}{" "}{data.ticket.label}</a>}</li>
              )}
              {hits.slice(0, 8).map((h, i) => (
                <li key={h.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); open(h.id); }}>
                  <strong>{h.title}</strong>{h.snippet && <div className="snippet"><Snippet text={h.snippet} /></div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <TicketCard ticket={data?.ticket ?? null} term={q} />
      {data && data.top.length > 0 && (
        <section><h2>{tr("Meistgelesen")}</h2><ul className="faq-tiles">{data.top.map((t) => <li key={t.id}>{link(t.id, t.title, <small>{t.category}</small>)}</li>)}</ul></section>
      )}
      {seen.length > 0 && (
        <section><h2>{tr("Zuletzt angesehen")}</h2><ul className="faq-tiles">{seen.map((t) => <li key={t.id}>{link(t.id, t.title, <small>{t.category}</small>)}</li>)}</ul></section>
      )}
      {data && data.categories.length > 0 && (
        <section>
          <h2>{tr("Kategorien")}</h2>
          <div className="faq-cats">
            {data.categories.map((c) => (
              <article key={c.id}>
                <h3>{c.title}</h3>
                <ul>{c.pages.map((p) => <li key={p.id}>{link(p.id, p.title)}</li>)}</ul>
                {c.more > 0 && <p className="muted small">{tr("und")}{" "}{c.more} {tr("weitere …")}</p>}
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Article({ id, open }: { id: string; open: (id: string | null) => void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [missing, setMissing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPage(null);
    setMissing(false);
    get<Page>(`/api/public/pages/${id}`).then((p) => { setPage(p); remember(id); document.title = `${p.title} – ${tr("Hilfe")}`; }).catch(() => setMissing(true));
  }, [id]);
  // Links to other pages of the FAQ (/n/<id> in the app) point into the portal; a plain click stays in the page.
  const onClick = (e: React.MouseEvent) => {
    const m = (e.target as Element).closest("a")?.getAttribute("href")?.match(/^\/hilfe\/\?p=([0-9a-f-]{36})$/);
    if (m && !e.ctrlKey && !e.metaKey) { e.preventDefault(); open(m[1]); }
  };
  if (missing) return <><p><a href="/hilfe/" onClick={(e) => { e.preventDefault(); open(null); }}>{tr("← Alle Antworten")}</a></p><h1>{tr("Nicht gefunden")}</h1><p className="muted">{tr("Diese Seite gibt es nicht (mehr) oder sie ist nicht öffentlich.")}</p></>;
  if (!page) return <p className="muted">{tr("Wird geladen …")}</p>;
  return (
    <article className="hilfe-article">
      <p className="hilfe-crumbs"><a href="/hilfe/" onClick={(e) => { e.preventDefault(); open(null); }}>{tr("← Alle Antworten")}</a>{page.breadcrumb.map((b) => <span key={b.id}> / {b.title}</span>)}</p>
      <h1>{page.title}</h1>
      <div ref={body} className="prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: portalLinks(page.content_html) }} />
      <p className="muted small">{tr("Zuletzt geändert:")}{" "}{new Date(page.updated_at).toLocaleDateString(dateLocale())}</p>
      <TicketCard ticket={page.ticket} term={page.title} />
    </article>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Portal /></StrictMode>);
