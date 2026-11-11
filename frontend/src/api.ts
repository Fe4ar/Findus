import { tr, dateLocale } from "./i18n";
export type Kind = "area" | "folder" | "page" | "file" | "map" | "link";

export interface NodeSummary {
  id: string;
  kind: Kind;
  title: string;
  status: "draft" | "published";
  position: number;
  has_children: boolean;
  writable?: boolean; // tree listings only
  vis?: { kind: "public" | "login" | "team" | "admin"; badge: string; text: string }; // wiki containers in tree listings
  team?: string | null; // team areas: the owning team
  shared?: string[]; // folders: names of the teams this folder is shared with
  from?: string; // folders listed under "Von anderen Teams": the sharing team
  can_share?: boolean; // folders of a team area, for its leader and admins
}

export interface FileVersion {
  id: string;
  original_name: string;
  mime: string;
  size: number;
  user: string | null;
  comment: string;
  source: string;
  created_at: string;
  url: string;
}

export interface NodeDetail extends NodeSummary {
  parent: string | null;
  description: string;
  tags: string[];
  version: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  is_public: boolean;
  space: "wiki" | "karte";
  breadcrumb: { id: string; title: string; kind: Kind }[];
  via_team?: number; // reached through a folder another team shared with this team
  via_user?: boolean; // reached through a private folder somebody shared with this user alone
  permissions: { read: boolean; write: boolean; publish: boolean; manage: boolean };
  content?: object | null;
  target?: string | null; // links: the referenced node (a .drawio file)
  content_html?: string;
  versions?: FileVersion[];
}

export interface Me {
  authenticated: boolean;
  username?: string;
  name?: string;
  is_superuser?: boolean;
  is_admin?: boolean;
  can_overview?: boolean;
  can_create_area?: boolean;
  can_download?: boolean;
  collabora?: boolean;
  nav?: { private?: string | null; teams: { id: number; name: string; area: string; write: boolean }[]; other: boolean; public_areas: string[] };
  todoist?: boolean; // the administration allows the Todoist integration
  features?: string[]; // functions of the user's teams: wiki, faq, tasks, network, export
  teams?: { id: number; name: string; leader: boolean; can_write: boolean }[];
  theme?: Theme;
  language?: string;
  must_change_password?: boolean; // the start admin has to set a new password first
  idle_logout_minutes?: number; // automatic sign-out after this long without activity, 0 = off
}

export type Theme = "auto" | "light" | "dark";

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    // DRF field errors look like {"url": "..."} or {"url": ["..."]}: show the first message instead of just the status.
    const field = body && typeof body === "object" ? Object.values(body).flat().find((v) => typeof v === "string") : undefined;
    super(body?.detail || (field as string | undefined) || tr("Fehler {status}", { status }));
  }
}

function csrfToken() {
  return document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] ?? "";
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (import.meta.env.VITE_DEMO) return (await import("./demo")).demoApi<T>(path, opts);
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-CSRFToken": csrfToken(),
      ...(opts.body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  // A refused request may mean the session ran out (inactivity): the app checks /me and returns to the login.
  if ((res.status === 401 || res.status === 403) && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event("findus-auth-check"));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString(dateLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
