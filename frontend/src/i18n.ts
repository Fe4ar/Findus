import { useSyncExternalStore } from "react";
import en from "./locales/en.json";

// Lightweight UI translation. The German text in the code is the key and the reference; other languages are dictionaries
// (src/locales/<code>.json: German text -> translation). A missing entry falls back to the German text.
// Placeholders: t("Hallo {name}", { name }). To add a language: add the file, import it below and add it to LANGS.
export type Lang = "de" | "en";
export const LANGS: { code: Lang; name: string }[] = [{ code: "de", name: "Deutsch" }, { code: "en", name: "English" }];
const dictionaries: Record<string, Record<string, string>> = { en };
const STORE = "findus-lang";

const known = (l: string | null | undefined): l is Lang => !!l && LANGS.some((x) => x.code === l);
function initial(): Lang {
  try { const s = localStorage.getItem(STORE); if (known(s)) return s; } catch { /* no storage */ }
  return "de"; // German is the default; users choose in the profile menu (anonymous visitors on the login page)
}
let lang: Lang = initial();
const listeners = new Set<() => void>();
document.documentElement.lang = lang;

export function getLang(): Lang { return lang; }
export function setLang(l: string | null | undefined) {
  if (!known(l) || l === lang) return;
  lang = l;
  try { localStorage.setItem(STORE, l); } catch { /* not remembered */ }
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
/** Re-renders the component when the language changes (use once near the root; children re-render with it). */
export function useLang(): Lang { return useSyncExternalStore((f) => { listeners.add(f); return () => listeners.delete(f); }, () => lang); }

// Keys that had no translation in the current language (for checking completeness: window.__i18nMissing).
const missing = new Set<string>();
(window as unknown as { __i18nMissing: Set<string> }).__i18nMissing = missing;

export function tr(key: string, vars?: Record<string, string | number | null | undefined>): string {
  if (lang !== "de" && key && !dictionaries[lang]?.[key]) missing.add(key);
  const text = (lang !== "de" && dictionaries[lang]?.[key]) || key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m)) : text;
}
/** Texts that the server generates in German (visibility badges, team group names, system area titles): translated by pattern. */
export function trs(s: string): string {
  if (lang === "de" || !s) return s;
  const inherited = / \(geerbt\)$/.test(s);
  const core = inherited ? s.replace(/ \(geerbt\)$/, "") : s;
  const suffix = inherited ? tr(" (geerbt)") : "";
  let m = core.match(/^Nur (.+) und Admin$/);
  if (m) return tr("Nur {names} und Admin", { names: m[1] }) + suffix;
  m = core.match(/^(Nur .+)$/);
  if (m && dictionaries[lang]?.[core]) return tr(core) + suffix;
  if (m) return tr("Nur {names}", { names: core.slice(4) }) + suffix;
  m = core.match(/^(.*) · (Lesen|Schreiben)$/);
  if (m) return `${m[1]} · ${tr(m[2])}` + suffix;
  return tr(core) + suffix;
}
export const dateLocale = () => (lang === "en" ? "en-GB" : "de-DE");
