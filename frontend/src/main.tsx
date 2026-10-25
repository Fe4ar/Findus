import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, Me } from "./api";
import { Tree } from "./Tree";
import { NodeView } from "./NodeView";
import { Dashboard } from "./Dashboard";
import { Tasks } from "./Tasks";
import { NetView } from "./Karte";
import { Search } from "./Search";
import "./styles.css";

type Tab = "overview" | "wiki" | "map";
// Top-level tabs. A new tab adds an entry here and a case in the content switch in App.
const TABS: { id: Tab; label: string; path: string }[] = [
  { id: "overview", label: "Übersicht", path: "/" },
  { id: "wiki", label: "Wiki", path: "/wiki" },
  { id: "map", label: "Netzwerk", path: "/netzwerk" },
];

function currentId() {
  return location.pathname.match(/^\/n\/([0-9a-f-]{36})/)?.[1] ?? null;
}

// The tab was called "Karte" before; old /karte links keep working.
if (location.pathname.startsWith("/karte")) {
  history.replaceState(null, "", location.pathname.replace(/^\/karte/, "/netzwerk") + location.search);
}

function currentMapId() {
  return location.pathname.match(/^\/netzwerk\/([0-9a-f-]{36})/)?.[1] ?? null;
}

function currentTab(): Tab {
  if (currentId()) return "wiki";
  return TABS.find((t) => t.path !== "/" && location.pathname.startsWith(t.path))?.id ?? "overview";
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return (
    <main className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            onLogin(await api<Me>("/api/auth/login", { method: "POST", body: { username, password } }));
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Anmeldung fehlgeschlagen.");
          }
        }}
      >
        <h1><img src="/findus.svg" alt="" />Findus</h1>
        <label>
          Benutzername
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          Passwort
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary">Anmelden</button>
      </form>
    </main>
  );
}

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [selected, setSelected] = useState<string | null>(currentId());
  const [mapId, setMapId] = useState<string | null>(currentMapId());
  const [tab, setTab] = useState<Tab>(currentTab());
  // Bumped after any change so the tree reloads the affected branches.
  const [treeVersion, setTreeVersion] = useState(0);
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "auto");

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe);
    const onPop = () => {
      setSelected(currentId());
      setMapId(currentMapId());
      setTab(currentTab());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  const select = useCallback((id: string | null) => {
    history.pushState(null, "", id ? `/n/${id}` : "/wiki");
    setSelected(id);
    setTab("wiki");
  }, []);
  const selectMap = useCallback((id: string | null) => {
    history.pushState(null, "", id ? `/netzwerk/${id}` : "/netzwerk");
    setMapId(id);
    setTab("map");
  }, []);
  const open = useCallback((t: Tab) => {
    history.pushState(null, "", TABS.find((x) => x.id === t)!.path);
    setSelected(null);
    setMapId(null);
    setTab(t);
  }, []);
  const changed = useCallback(() => setTreeVersion((v) => v + 1), []);

  if (!me) return null;
  if (!me.authenticated) return <Login onLogin={setMe} />;

  return (
    <div className={tab === "overview" ? "layout full" : "layout"}>
      <header className="topbar">
        <a href="/" className="brand" onClick={(e) => { e.preventDefault(); open("overview"); }}><img src="/findus.svg" alt="" className="logo" />Findus</a>
        <nav className="tabs" aria-label="Bereiche">
          {TABS.map((t) => (
            <a key={t.id} href={t.path} className="tab" aria-current={tab === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); open(t.id); }}>{t.label}</a>
          ))}
        </nav>
        <span className="spacer" />
        <Search onSelect={select} />
        <select aria-label="Darstellung" value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="auto">System</option>
          <option value="light">Hell</option>
          <option value="dark">Dunkel</option>
        </select>
        <span className="who">{me.name}</span>
        {me.is_superuser && <a href="/admin/">Verwaltung</a>}
        <button onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMe({ authenticated: false }); }}>
          Abmelden
        </button>
      </header>
      {tab === "wiki" && (
        <nav className="sidebar" aria-label="Ordnerbaum">
          <Tree selected={selected} onSelect={select} version={treeVersion} onChanged={changed} />
        </nav>
      )}
      {tab === "map" && (
        <nav className="sidebar" aria-label="Netzwerk">
          <Tree space="karte" selected={mapId} onSelect={selectMap} version={treeVersion} onChanged={changed} />
        </nav>
      )}
      <main className="content">
        {tab === "overview" ? (
          <>
            <h1>Übersicht</h1>
            <h2>Aktuelle Aufgaben</h2>
            <Tasks />
            <h2>Dienste im Netz</h2>
            <Dashboard />
          </>
        ) : tab === "map" ? (
          mapId ? <NetView key={mapId} id={mapId} onChanged={changed} /> : (
            <>
              <h1>Netzwerk</h1>
              <p className="muted">Links eine Karte oder einen Netzplan wählen. Rechtsklick legt Ordner, Karten und Netzplan-Verknüpfungen an, Ziehen verschiebt.</p>
            </>
          )
        ) : selected ? (
          <NodeView key={selected} id={selected} onSelect={select} onChanged={changed} />
        ) : (
          <>
            <h1>Wiki</h1>
            <p className="muted">Links den Ordnerbaum nutzen (Rechtsklick legt Neues an).</p>
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
