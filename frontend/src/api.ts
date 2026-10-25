export type Kind = "area" | "folder" | "page" | "file" | "map" | "link";

export interface NodeSummary {
  id: string;
  kind: Kind;
  title: string;
  status: "draft" | "published";
  position: number;
  has_children: boolean;
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
  breadcrumb: { id: string; title: string; kind: Kind }[];
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
}

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(body?.detail || `Fehler ${status}`);
  }
}

function csrfToken() {
  return document.cookie.match(/(?:^|; )csrftoken=([^;]+)/)?.[1] ?? "";
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
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
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
