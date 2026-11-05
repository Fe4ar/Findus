import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface NavTab { id: string; label: string; path: string; team?: boolean }

/**
 * The top navigation on one line. When the tabs do not fit, the surplus goes into a "Mehr ▾" menu: first the team tabs from
 * the end (the first team stays longest), then the other tabs from the end. "Übersicht" and the tab the user is on always
 * stay visible.
 */
export function TabNav({ tabs, section, go }: { tabs: NavTab[]; section: string; go: (path: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const key = tabs.map((t) => `${t.id}:${t.label}`).join("|") + `@${section}`;

  // Measures an invisible copy of all tabs plus the "Mehr" button and hides tabs until the rest fits the available width.
  const fit = () => {
    const w = wrap.current, p = probe.current;
    if (!w || !p) return;
    const items = [...p.children] as HTMLElement[];
    const gap = parseFloat(getComputedStyle(p).columnGap) || 0;
    const pad = parseFloat(getComputedStyle(p).paddingLeft) * 2;
    const moreW = items[items.length - 1].offsetWidth;
    const width = (t: NavTab) => items[tabs.indexOf(t)].offsetWidth;
    const teams = tabs.filter((t) => t.team);
    const order = [...teams.slice(1).reverse(), ...tabs.filter((t) => !t.team && t.id !== "overview").reverse(), ...teams.slice(0, 1)]
      .filter((t) => t.id !== section);
    const gone: NavTab[] = [];
    const need = () => {
      const shown = tabs.filter((t) => !gone.includes(t));
      return pad + shown.reduce((s, t) => s + width(t), 0) + gap * (shown.length - 1 + (gone.length ? 1 : 0)) + (gone.length ? moreW : 0);
    };
    const room = w.clientWidth - 6; // a little slack: the hidden copy and the real tabs differ by a pixel or two (fonts, buttons)
    while (need() > room && order.length) gone.push(order.shift()!);
    setHidden((h) => (h.join() === gone.map((t) => t.id).join() ? h : gone.map((t) => t.id)));
  };
  useLayoutEffect(fit, [key]);
  useEffect(() => {
    const ro = new ResizeObserver(fit);
    if (wrap.current) ro.observe(wrap.current);
    document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, [key]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => { if (!more.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", esc); };
  }, [open]);

  const link = (t: NavTab, extra?: Partial<React.HTMLAttributes<HTMLAnchorElement>>) => (
    <a key={t.id} href={t.path} className="tab" aria-current={section === t.id ? "page" : undefined} {...extra}
      onClick={(e) => { e.preventDefault(); setOpen(false); go(t.path); }}>{t.label}</a>
  );
  const rest = tabs.filter((t) => hidden.includes(t.id));
  return (
    <div className="tabs-wrap" ref={wrap}>
      <nav className="tabs" aria-label="Bereiche">
        {tabs.filter((t) => !hidden.includes(t.id)).map((t) => link(t))}
        {rest.length > 0 && (
          <div className="tabs-more" ref={more}>
            <button type="button" className="tab" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>Mehr ▾</button>
            {open && (
              <div className="tabs-more-menu" role="menu" aria-label="Weitere Bereiche">
                {rest.map((t) => link(t, { role: "menuitem" }))}
              </div>
            )}
          </div>
        )}
      </nav>
      <div className="tabs tabs-probe" ref={probe} aria-hidden="true">
        {tabs.map((t) => <span key={t.id} className="tab">{t.label}</span>)}
        <span className="tab">Mehr ▾</span>
      </div>
    </div>
  );
}
