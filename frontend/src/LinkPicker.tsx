import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface Hit { id: string; kind: string; title: string; path: string; group?: string }
const KIND_LABEL: Record<string, string> = { folder: "Ordner", page: "Seite", file: "Datei" };

/** "Link einfügen": pick a Findus page, folder or file by title (the normal search, so only what the user may read) or type an external address.
 *  onDone gets the address and, for a Findus target, its title; "" removes the link. */
export function LinkPicker({ prev, onDone, onCancel }: { prev?: string; onDone: (href: string, title?: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"findus" | "extern">(prev && !prev.startsWith("/n/") ? "extern" : "findus");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const [url, setUrl] = useState(prev && !prev.startsWith("/n/") ? prev : "https://");
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    if (tab !== "findus" || !q.trim()) return setHits(null);
    let stale = false;
    const t = setTimeout(() => api<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`).then((h) => {
      if (!stale) { setHits(h.filter((x) => x.kind in KIND_LABEL).slice(0, 12)); setActive(0); }
    }).catch(() => !stale && setHits([])), 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, tab]);
  const pick = (h: Hit) => onDone(`/n/${h.id}`, h.title);
  return (
    <dialog ref={ref} className="dialog modal link-picker" aria-label="Link einfügen" onClose={onCancel}>
      <h2>Link einfügen</h2>
      <div className="tabs-inline" role="tablist">
        <button role="tab" type="button" aria-selected={tab === "findus"} onClick={() => setTab("findus")}>Findus-Seite</button>
        <button role="tab" type="button" aria-selected={tab === "extern"} onClick={() => setTab("extern")}>Externe Adresse</button>
      </div>
      {tab === "findus" ? (
        <>
          <input type="search" autoFocus placeholder="Seite, Ordner oder Datei suchen …" aria-label="Findus-Seite suchen" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && hits?.length) { e.preventDefault(); setActive((active + 1) % hits.length); }
              else if (e.key === "ArrowUp" && hits?.length) { e.preventDefault(); setActive((active - 1 + hits.length) % hits.length); }
              else if (e.key === "Enter" && hits?.[active]) { e.preventDefault(); pick(hits[active]); }
            }} />
          {hits && (hits.length ? (
            <ul className="link-hits" role="listbox">
              {hits.map((h, i) => (
                <li key={h.id} role="option" aria-selected={i === active}>
                  <button type="button" className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => pick(h)}>
                    <strong>{h.title}</strong><small className="muted">{KIND_LABEL[h.kind]}{h.path || h.group ? ` · ${h.path || h.group}` : ""}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted small">Nichts gefunden.</p>)}
          {!hits && <p className="muted small">Tippe einen Teil des Titels. Es werden nur Inhalte angezeigt, die du sehen darfst.</p>}
        </>
      ) : (
        <label>Adresse<input type="url" value={url} autoFocus onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) { e.preventDefault(); onDone(url.trim()); } }} /></label>
      )}
      <div className="actions">
        {prev && <button type="button" className="danger" onClick={() => onDone("")}>Link entfernen</button>}
        <span className="spacer" />
        <button type="button" onClick={() => ref.current?.close()}>Abbrechen</button>
        {tab === "extern" && <button type="button" className="primary" disabled={!url.trim()} onClick={() => onDone(url.trim())}>Übernehmen</button>}
      </div>
    </dialog>
  );
}
