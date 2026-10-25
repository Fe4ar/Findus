// Static demo (VITE_DEMO=1, scripts/build-demo.sh): answers API calls from recorded fictional data, rejects writes.
// demo-data.json comes from scripts/demo-record.sh; this file is not part of the normal build.
import recorded from "./demo-data.json";
import { ApiError, NodeDetail } from "./api";

const DATA = recorded as Record<string, unknown>;
const ME = { authenticated: true, username: "demo", name: "Demo", is_superuser: false, can_create_area: false, theme: "auto" };
const READ_ONLY = "Demo: Änderungen werden nicht gespeichert.";

const banner = document.createElement("div");
banner.className = "demo-banner";
banner.setAttribute("role", "status");
banner.textContent = "Demo mit erfundenen Daten. Änderungen werden nicht gespeichert.";
document.body.prepend(banner);

function search(q: string) {
  const needle = q.toLowerCase();
  return Object.entries(DATA)
    .filter(([path]) => /^\/api\/nodes\/[0-9a-f-]{36}$/.test(path))
    .map(([, n]) => n as NodeDetail)
    .filter((n) => `${n.title} ${n.content_html ?? ""}`.toLowerCase().includes(needle))
    .map((n) => ({ id: n.id, kind: n.kind, title: n.title, path: n.breadcrumb.map((b) => b.title).join(" / "),
                   snippet: (n.content_html ?? "").replace(/<[^>]+>/g, " ").slice(0, 160) }));
}

export async function demoApi<T>(path: string, opts: { method?: string; body?: unknown }): Promise<T> {
  const method = opts.method ?? "GET";
  if (path === "/api/auth/settings") return undefined as T; // theme switch stays usable (browser only)
  if (method !== "GET") throw new ApiError(403, { detail: READ_ONLY });
  if (path === "/api/auth/me") return { ...ME } as T;
  if (path.startsWith("/api/search?")) return search(new URLSearchParams(path.split("?")[1]).get("q") ?? "") as T;
  if (path in DATA) return structuredClone(DATA[path]) as T;
  if (path.startsWith("/api/tree?")) return [] as T;
  throw new ApiError(404, { detail: "In der Demo nicht verfügbar." });
}
