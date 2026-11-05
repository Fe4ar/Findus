import type { ReactNode } from "react";
import type { Me } from "./api";

/** An optional addition from a local module; files in ./local/ export one as default (none in a plain checkout).
 *  A page has a path and a nav tab; "home" ones are shown at the top of the Übersicht instead. */
export interface Ext { id: string; label: string; path: string; home?: boolean; show: (me: Me) => boolean; render: () => ReactNode }

const all: Ext[] = Object.values(import.meta.glob<{ default: Ext }>("./local/*.tsx", { eager: true })).map((m) => m.default).filter(Boolean); // helper files in local/ have no default export
export const extensions = all.filter((e) => !e.home);
export const homeExtension = (me: Me) => all.find((e) => e.home && e.show(me));
