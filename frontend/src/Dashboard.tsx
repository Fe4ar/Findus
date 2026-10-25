import { useEffect, useState } from "react";
import { api } from "./api";

interface Service {
  group: string;
  name: string;
  icon: string;
  url: string;
  online: boolean | null;
}

export function Dashboard() {
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Service[]>("/api/services").then(setServices).catch(() => setError("Dienste konnten nicht geladen werden."));
  }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!services) return <p className="muted">Dienste werden geprüft …</p>;
  const groups = [...new Set(services.map((s) => s.group))];
  return (
    <div className="dashboard">
      {groups.map((g) => (
        <section key={g}>
          <h2>{g}</h2>
          <ul className="tiles">
            {services.filter((s) => s.group === g).map((s) => (
              <li key={s.url}>
                <a className="tile" href={s.url} target="_blank" rel="noopener noreferrer">
                  <span className="tile-icon" aria-hidden="true">{s.icon}</span>
                  <span className="tile-name">{s.name}</span>
                  <span className="tile-url muted">{s.url.replace(/^https?:\/\//, "")}</span>
                  <span className={`dot ${s.online ? "up" : "down"}`} title={s.online ? "erreichbar" : "nicht erreichbar"}
                    aria-label={s.online ? "erreichbar" : "nicht erreichbar"} />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="muted">Liste pflegen: backend/services.json im Repo, danach den web-Container neu bauen.</p>
    </div>
  );
}
