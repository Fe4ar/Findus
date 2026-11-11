import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { Me, Theme } from "./api";
import { Integrations } from "./Integrations";
import { adminAllowed } from "./Admin";
import { PasswordDialog } from "./Password";
import { tr, getLang, LANGS, Lang } from "./i18n";

export const THEMES: [Theme, string, string][] = [["light", "☀️", "Hell"], ["dark", "🌙", "Dunkel"], ["auto", "🖥️", "Automatisch"]];

/** Initials from "First Last" (falls back to the username): "Anna Berg" → "AB", "admin" → "AD". */
export function initials(name: string) {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

/** Theme choice as a radio group; used in the menu, the settings dialog and for anonymous visitors. */
export function ThemeSwitch({ theme, onTheme, role = "radio" }: { theme: Theme; onTheme: (t: Theme) => void; role?: "radio" | "menuitemradio" }) {
  return (
    <div className="theme-switch" role={role === "radio" ? "radiogroup" : "group"} aria-label={tr("Darstellung")}>
      {THEMES.map(([id, icon, label]) => (
        <button key={id} role={role} aria-checked={theme === id} title={tr(label)} onClick={() => onTheme(id)}>
          <span aria-hidden="true">{icon}</span> <span className="label">{tr(label)}</span>
        </button>
      ))}
    </div>
  );
}

/** Language choice (per user, stored on the account); same look as the theme switch. */
export function LangSwitch({ onLang, role = "radio" }: { onLang: (l: Lang) => void; role?: "radio" | "menuitemradio" }) {
  const current = getLang();
  return (
    <div className="theme-switch lang-switch" role={role === "radio" ? "radiogroup" : "group"} aria-label={tr("Sprache")}>
      {LANGS.map(({ code, name }) => (
        <button key={code} role={role} aria-checked={current === code} title={name} onClick={() => onLang(code)}>
          <span className="label">{name}</span>
        </button>
      ))}
    </div>
  );
}

interface Props {
  me: Me;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onLang: (l: Lang) => void;
  onLogout: () => void;
  onMe?: (me: Me) => void;
}

/** Round avatar with initials; opens the account menu (WAI-ARIA menu button: arrows, Home/End, Esc). */
export function ProfileMenu({ me, theme, onTheme, onLang, onLogout, onMe }: Props) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [integrations, setIntegrations] = useState(false);
  const [password, setPassword] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const name = me.name || me.username || "";
  useEffect(() => {
    const openSettings = () => setSettings(true);
    addEventListener("findus-settings", openSettings);
    return () => removeEventListener("findus-settings", openSettings);
  }, []);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") close(e.key === "Escape");
  };

  const link = (href: string, label: string) => (
    <a role="menuitem" tabIndex={-1} href={href} onClick={() => close(false)}>{label}</a>
  );

  return (
    <div className="profile">
      <button ref={button} className="avatar" aria-haspopup="menu" aria-expanded={open} aria-label={tr("Konto: {name}", { name })}
        title={name} onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }}>
        {initials(name)}
      </button>
      {open && (
        <div ref={menu} className="profile-menu" role="menu" aria-label={tr("Konto")} onKeyDown={onKey}>
          <div className="profile-head" aria-hidden="true">
            <span className="avatar large">{initials(name)}</span>
            <span><strong>{name}</strong>{me.username && me.username !== name && <small>{me.username}</small>}</span>
          </div>
          <div className="profile-section" aria-hidden="true">{tr("Darstellung")}</div>
          <ThemeSwitch theme={theme} onTheme={onTheme} role="menuitemradio" />
          <LangSwitch onLang={onLang} role="menuitemradio" />
          <hr />
          <button role="menuitem" tabIndex={-1} onClick={() => { close(false); setSettings(true); }}>{tr("Einstellungen")}</button>
          <button role="menuitem" tabIndex={-1} onClick={() => { close(false); setPassword(true); }}>{tr("Passwort ändern")}</button>
          {me.todoist && me.features?.includes("tasks") && (
            <button role="menuitem" tabIndex={-1} onClick={() => { close(false); setIntegrations(true); }}>{tr("Integrationen")}</button>
          )}
          {adminAllowed(me) && link("/verwaltung", tr("Verwaltung"))}
          <hr />
          <button role="menuitem" tabIndex={-1} onClick={() => { close(false); onLogout(); }}>{tr("Abmelden")}</button>
        </div>
      )}
      {password && <PasswordDialog onClose={() => { setPassword(false); button.current?.focus(); }} onDone={(m) => onMe?.(m)} />}
      {integrations && <Integrations onClose={() => { setIntegrations(false); button.current?.focus(); }} />}
      {settings && <Settings me={me} theme={theme} onTheme={onTheme} onLang={onLang} onClose={() => { setSettings(false); button.current?.focus(); }} />}
    </div>
  );
}

function Settings({ me, theme, onTheme, onLang, onClose }: { me: Me; theme: Theme; onTheme: (t: Theme) => void; onLang: (l: Lang) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog ref={ref} className="dialog modal" aria-labelledby="settings-title" onClose={onClose}>
      <h2 id="settings-title">{tr("Einstellungen")}</h2>
      <dl className="settings">
        <dt>{tr("Name")}</dt><dd>{me.name || "–"}</dd>
        <dt>{tr("Benutzername")}</dt><dd>{me.username}</dd>
        <dt>{tr("Darstellung")}</dt>
        <dd><ThemeSwitch theme={theme} onTheme={onTheme} /><small className="muted">{tr("Gilt für dein Konto auf allen Geräten.")}</small></dd>
        <dt>{tr("Sprache")}</dt>
        <dd><LangSwitch onLang={onLang} /><small className="muted">{tr("Gilt für dein Konto auf allen Geräten.")}</small></dd>
      </dl>
      <div className="actions">
        <button className="primary" onClick={() => ref.current?.close()}>{tr("Schließen")}</button>
      </div>
    </dialog>
  );
}
