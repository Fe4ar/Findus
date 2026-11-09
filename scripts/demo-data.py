# Seeds fictional content into an EMPTY throwaway database and prints the recorded API responses as JSON
# (frontend/src/demo-data.json). Run only via scripts/demo-record.sh, never against a real instance.
import base64, json, sys
from pathlib import Path
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.test import Client
from core import maps, services
from core.files import _save_version
from core.models import Node, PageRevision
from core.search import revision_text
from core.views import sanitize

assert not get_user_model().objects.exists(), "demo-data.py needs an empty database"
u = get_user_model().objects.create_superuser("demo", "demo@example.org", None, first_name="Demo")

def node(kind, title, parent=None, pos=0, **kw):
    return Node.objects.create(kind=kind, title=title, parent=parent, position=pos, created_by=u, updated_by=u, **kw)

def page(title, parent, pos, *versions, **kw):
    n = node(Node.PAGE, title, parent, pos, **kw)
    for i, h in enumerate(versions):
        h = sanitize(h)
        PageRevision.objects.create(node=n, content={}, content_html=h, user=u, comment="Erste Fassung" if i == 0 else "Ergänzt")
        n.version, n.search_text = i + 1, revision_text(n.kind, {}, h)
    n.save()
    return n

def file(title, parent, pos, data, comment="Hochgeladen"):
    f = node(Node.FILE, title, parent, pos)
    _save_version(f, ContentFile(data.encode(), name=title), title, u, comment)
    return f

DRAWIO = ('<mxfile><diagram name="Netz"><mxGraphModel page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
          + "".join(f'<mxCell id="{i}" value="{v}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" '
                    f'vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="170" height="56" as="geometry"/></mxCell>'
                    for i, v, x, y in [("r", "Router&lt;br&gt;192.0.2.1", 190, 0), ("s", "Switch&lt;br&gt;192.0.2.6", 190, 110),
                                       ("h", "Hypervisor&lt;br&gt;192.0.2.10", 0, 220), ("n", "NAS&lt;br&gt;192.0.2.7", 380, 220)])
          + "".join(f'<mxCell id="e{a}{b}" style="endArrow=none;html=1;" edge="1" parent="1" source="{a}" target="{b}">'
                    '<mxGeometry relative="1" as="geometry"/></mxCell>' for a, b in [("r", "s"), ("s", "h"), ("s", "n")])
          + "</root></mxGraphModel></diagram></mxfile>")

hb = node(Node.AREA, "Handbücher", pos=0)
page("Erste Schritte", hb, 0,
     "<h2>Willkommen</h2><p>Dies ist die Demo von Findus mit erfundenen Daten.</p>",
     "<h2>Willkommen</h2><p>Dies ist die Demo von Findus mit erfundenen Daten. Links der Ordnerbaum, oben die Suche.</p>"
     "<ul><li>Seiten haben eine Versionsgeschichte mit Vergleich.</li><li>Dateien haben Versionen, Office-Dateien öffnen in OnlyOffice.</li>"
     "<li>Schaubilder (draw.io) lassen sich in Seiten einbetten.</li></ul>")
page("Backup-Konzept", hb, 1,
     "<p>Täglich 02:00 Uhr Sicherung auf das NAS, wöchentlich zusätzlich auf eine externe Platte.</p>"
     "<table><thead><tr><th>Was</th><th>Wie oft</th><th>Aufbewahrung</th></tr></thead><tbody>"
     "<tr><td>Datenbank</td><td>täglich</td><td>14 Tage</td></tr><tr><td>Dateien</td><td>täglich</td><td>30 Tage</td></tr>"
     "<tr><td>VM-Snapshots</td><td>wöchentlich</td><td>4 Wochen</td></tr></tbody></table>")
net = node(Node.FOLDER, "Netzwerk", hb, 2)
plan = file("Netzplan.drawio", net, 1, DRAWIO, "Plan erstellt")
page("Netzplan", net, 0, f'<p>Übersicht des Beispielnetzes 192.0.2.0/24.</p><div data-drawio="{plan.id}"></div>')
it = node(Node.AREA, "IT-Betrieb", pos=1)
page("Wartungsfenster", it, 0,
     "<p>Updates jeden ersten Dienstag im Monat ab 19:00 Uhr.</p><pre><code>apt update &amp;&amp; apt full-upgrade -y\nreboot</code></pre>")
page("Neue Mitarbeitende einrichten", it, 1, "<p>Konto anlegen, Gruppe zuweisen, Laptop ausgeben.</p>", status=Node.DRAFT)
file("Checkliste-Server.txt", it, 2, "Checkliste neuer Server\n- Updates einspielen\n- Monitoring eintragen\n- Backup prüfen\n")
faq = Node.objects.get(kind=Node.AREA, title="FAQ für Anwender")  # public area from the migrations
page("Passwort vergessen?", faq, 0, "<p>Bitte bei der IT melden, das Passwort wird dann zurückgesetzt.</p>")

# Live checks would all fail for the fictional addresses; one device stays offline on purpose.
fake = lambda urls: {x: "192.0.2.7" not in x for x in urls}
services.check_all = maps.check_all = fake
services.SERVICES_FILE = Path(services.__file__).parent.parent / "services.example.json"  # never a local services.json

c = Client(SERVER_NAME="localhost")
c.force_login(u)
out = {}
def get(path):
    r = c.get(path)
    assert r.status_code == 200, (path, r.status_code)
    out[path] = data = r.json()
    return data

for p in ("/api/services", "/api/pages"):
    get(p)
queue = get("/api/tree?space=wiki") + get("/api/tree?space=karte")
while queue:
    n = queue.pop(0)
    get(f"/api/nodes/{n['id']}")
    hist = get(f"/api/nodes/{n['id']}/history")
    if n["kind"] in Node.REVISIONED:
        for r in hist:
            get(f"/api/nodes/{n['id']}/history/{r['id']}")
    if n["kind"] == Node.MAP:
        get(f"/api/maps/{n['id']}/status")
    if n["kind"] == Node.PAGE:
        get(f"/api/nodes/{n['id']}/maps")
    if n["has_children"]:
        queue += get(f"/api/tree?parent={n['id']}")

def inline_files(x):
    """File downloads become data: URLs, so the demo needs no backend for them."""
    if isinstance(x, list):
        return [inline_files(i) for i in x]
    if not isinstance(x, dict):
        return x
    x = {k: inline_files(v) for k, v in x.items()}
    if str(x.get("url", "")).startswith("/media-dl/"):
        raw = b"".join(c.get(x["url"]).streaming_content)
        x["url"] = f"data:{x['mime']};base64,{base64.b64encode(raw).decode()}"
    return x

out = inline_files(out)
sys.stdout.write("DEMO-JSON " + json.dumps(out, ensure_ascii=False, sort_keys=True) + "\n")
