import pytest
from django.contrib.auth.models import User
from rest_framework.test import APIClient

from .models import Node


@pytest.fixture
def user(db):
    return User.objects.create_user("tester", password="x-test-pass-1")


@pytest.fixture
def client(user):
    c = APIClient()
    c.force_login(user)  # session login also covers the plain Django download view
    return c


def create(client, kind, title, parent=None):
    r = client.post("/api/nodes", {"kind": kind, "title": title, "parent": str(parent) if parent else None},
                    format="json")
    assert r.status_code == 201, r.content
    return r.json()["id"]


def test_anonymous_sees_nothing(client, db):
    area = create(client, "area", "IT")
    page = create(client, "page", "Seite", area)
    anon = APIClient()
    assert anon.get("/api/tree").json() == []
    assert anon.get(f"/api/nodes/{page}").status_code == 404
    assert anon.get(f"/api/nodes/{page}/history").status_code == 404
    assert anon.put(f"/api/pages/{page}/content", {"html": "x", "base_version": 1}, format="json").status_code == 404


def test_tree_and_breadcrumb(client):
    area = create(client, "area", "IT")
    folder = create(client, "folder", "Server", area)
    page = create(client, "page", "Proxmox", folder)
    assert [n["title"] for n in client.get("/api/tree").json()] == ["IT"]
    assert client.get(f"/api/tree?parent={area}").json()[0]["has_children"] is True
    crumbs = client.get(f"/api/nodes/{page}").json()["breadcrumb"]
    assert [c["title"] for c in crumbs] == ["IT", "Server"]


def test_parent_rules(client):
    area = create(client, "area", "IT")
    page = create(client, "page", "P", area)
    assert client.post("/api/nodes", {"kind": "folder", "title": "x"}, format="json").status_code == 400
    assert client.post("/api/nodes", {"kind": "page", "title": "x", "parent": page}, format="json").status_code == 400
    assert client.post("/api/nodes", {"kind": "area", "title": "x", "parent": area}, format="json").status_code == 400


def test_move_and_no_cycle(client):
    area = create(client, "area", "IT")
    a = create(client, "folder", "A", area)
    b = create(client, "folder", "B", a)
    assert client.patch(f"/api/nodes/{a}", {"parent": b}, format="json").status_code == 400
    assert client.patch(f"/api/nodes/{b}", {"parent": area}, format="json").status_code == 200
    assert Node.objects.get(pk=b).parent_id.hex == area.replace("-", "")


def test_soft_delete_hides_subtree(client):
    area = create(client, "area", "IT")
    folder = create(client, "folder", "F", area)
    page = create(client, "page", "P", folder)
    assert client.delete(f"/api/nodes/{folder}").status_code == 204
    assert client.get(f"/api/tree?parent={area}").json() == []
    assert client.get(f"/api/nodes/{page}").status_code == 404
    assert Node.objects.get(pk=page).deleted_at is not None


def test_page_save_conflict_and_sanitize(client):
    page = create(client, "page", "P", create(client, "area", "IT"))
    r = client.put(f"/api/pages/{page}/content",
                   {"html": "<p>ok<script>alert(1)</script></p><img src=x onerror=alert(1)>", "base_version": 1},
                   format="json")
    assert r.status_code == 200
    assert "script" not in r.json()["content_html"] and "onerror" not in r.json()["content_html"]
    assert r.json()["version"] == 2
    stale = client.put(f"/api/pages/{page}/content", {"html": "<p>alt</p>", "base_version": 1}, format="json")
    assert stale.status_code == 409
    assert stale.json()["current"]["content_html"].startswith("<p>ok")


def test_sanitize_keeps_drawio_block_only(client):
    page = create(client, "page", "P", create(client, "area", "IT"))
    html = '<div data-drawio="0d6c1a52-0000-4000-8000-000000000001" onclick="x()" style="a"></div>'
    r = client.put(f"/api/pages/{page}/content", {"html": html, "base_version": 1}, format="json")
    assert r.json()["content_html"] == '<div data-drawio="0d6c1a52-0000-4000-8000-000000000001"></div>'


def test_restore_creates_new_revision(client):
    page = create(client, "page", "P", create(client, "area", "IT"))
    client.put(f"/api/pages/{page}/content", {"html": "<p>eins</p>", "base_version": 1}, format="json")
    client.put(f"/api/pages/{page}/content", {"html": "<p>zwei</p>", "base_version": 2}, format="json")
    hist = client.get(f"/api/nodes/{page}/history").json()
    assert len(hist) == 2
    first = hist[-1]["id"]
    r = client.post(f"/api/nodes/{page}/history/{first}/restore")
    assert r.json()["content_html"] == "<p>eins</p>"
    assert len(client.get(f"/api/nodes/{page}/history").json()) == 3


# --- files & OnlyOffice ---------------------------------------------------------------------------------------

import jwt
from django.core.files.uploadedfile import SimpleUploadedFile


@pytest.fixture(autouse=True)
def media_tmp(settings, tmp_path):
    settings.MEDIA_ROOT = tmp_path
    settings.ONLYOFFICE_JWT_SECRET = "test-secret"


def upload(client, parent, name, data=b"hello", ctype="application/octet-stream"):
    r = client.post("/api/files", {"parent": parent, "file": SimpleUploadedFile(name, data, ctype)}, format="multipart")
    assert r.status_code == 201, r.content
    return r.json()


def test_upload_download_requires_login(client):
    area = create(client, "area", "IT")
    node = upload(client, area, "notes.txt", b"geheim")
    v = node["versions"][0]
    assert v["size"] == 6 and v["mime"] == "text/plain"
    r = client.get(v["url"])
    assert r.status_code == 200 and b"".join(r.streaming_content) == b"geheim"
    assert r["Content-Security-Policy"] == "sandbox"
    assert APIClient().get(v["url"]).status_code == 404


def test_html_is_never_inline(client):
    node = upload(client, create(client, "area", "IT"), "evil.html", b"<script>alert(1)</script>", "text/html")
    r = client.get(node["versions"][0]["url"])
    assert r["Content-Disposition"].startswith("attachment")


def test_file_versions_and_restore(client):
    node = upload(client, create(client, "area", "IT"), "a.txt", b"v1")
    r = client.post(f"/api/files/{node['id']}/versions", {"file": SimpleUploadedFile("a.txt", b"v2")}, format="multipart")
    versions = r.json()["versions"]
    assert len(versions) == 2
    r = client.post(f"/api/files/{node['id']}/versions/{versions[-1]['id']}/restore")
    newest = r.json()["versions"][0]
    assert newest["source"] == "restore" and len(r.json()["versions"]) == 3
    assert b"".join(client.get(newest["url"]).streaming_content) == b"v1"


def test_onlyoffice_config_signed(client):
    node = upload(client, create(client, "area", "IT"), "brief.docx", b"PK")
    cfg = client.get(f"/api/files/{node['id']}/onlyoffice-config?mode=edit").json()["config"]
    assert cfg["documentType"] == "word" and cfg["editorConfig"]["mode"] == "edit"
    assert cfg["document"]["url"].startswith("http://web:8000/internal/oo-download/")
    assert client.get(f"/api/files/{node['id']}/onlyoffice-config").json()["api_js"].startswith("/office/")
    payload = jwt.decode(cfg["token"], "test-secret", algorithms=["HS256"])
    assert payload["document"]["key"] == cfg["document"]["key"]
    assert APIClient().get(f"/api/files/{node['id']}/onlyoffice-config").status_code == 404


def test_onlyoffice_callback_rejects_bad_jwt(client):
    node = upload(client, create(client, "area", "IT"), "brief.docx", b"PK")
    cfg = client.get(f"/api/files/{node['id']}/onlyoffice-config?mode=edit").json()["config"]
    path = cfg["editorConfig"]["callbackUrl"].replace("http://web:8000", "")
    forged = jwt.encode({"status": 2, "url": "http://onlyoffice/x"}, "wrong", algorithm="HS256")
    assert client.post(path, {"token": forged}, format="json").status_code == 403
    assert client.post(path, {}, format="json").status_code == 403
    ok = jwt.encode({"status": 1}, "test-secret", algorithm="HS256")
    assert client.post(path, {"token": ok}, format="json").json() == {"error": 0}
    evil = jwt.encode({"status": 2, "url": "http://evil.example/x"}, "test-secret", algorithm="HS256")
    assert client.post(path, {"token": evil}, format="json").status_code == 400


def test_services_dashboard(client, monkeypatch):
    from . import services
    monkeypatch.setattr(services, "SERVICES_FILE", services.settings.BASE_DIR / "services.example.json")
    monkeypatch.setattr(services, "is_up", lambda url: "192.0.2.10" in url)
    services._cache.clear()
    assert APIClient().get("/api/services").status_code == 404
    items = client.get("/api/services").json()
    assert items and all({"group", "name", "icon", "url", "online"} <= set(s) for s in items)
    assert next(s for s in items if "192.0.2.10" in s["url"])["online"] is True
    assert not any(k in str(items).lower() for k in ("password", "passwort", "token"))


def test_board(client, monkeypatch, tmp_path):
    from . import board
    f = tmp_path / "board.md"
    f.write_text("# Brett\nFormat: | Nr | Auftrag | Wer | Status | Notiz |\n\n| Nr | Auftrag | Wer | Status | Notiz |\n"
                 "|----|---------|-----|--------|-------|\n| 1 | A \\| B | worker01 | 🔄 | VM104\\/CT102 |\n"
                 "| 2 | C | User | ❓ | |\n", encoding="utf-8")
    monkeypatch.setattr(board, "BOARD_FILE", f)
    assert APIClient().get("/api/board").status_code == 404
    data = client.get("/api/board").json()
    assert data["updated"]
    assert data["rows"] == [
        {"nr": "1", "task": "A | B", "who": "worker01", "status": "🔄", "note": "VM104/CT102"},
        {"nr": "2", "task": "C", "who": "User", "status": "❓", "note": ""},
    ]
    monkeypatch.setattr(board, "BOARD_FILE", tmp_path / "missing.md")
    assert client.get("/api/board").json() == {"updated": None, "rows": []}
def test_testkarte_migrated(client):
    from .models import Node
    node = Node.objects.get(space="karte", kind="map", title="Testkarte")
    content = node.revisions.first().content
    ids = {e["id"] for e in content["elements"]}
    assert content["testdaten"] is True
    links = [e for e in content["elements"] if e["type"] == "link"]
    assert links and all(e["from"] in ids and e["to"] in ids for e in links)
    rack = next(e for e in content["elements"] if e["type"] == "rack")
    for e in content["elements"]:
        if e.get("rack"):
            assert 1 <= e["rack"]["u"] and e["rack"]["u"] + e["rack"]["h"] - 1 <= rack["units"], e


def test_maps_tree_is_separate(client):
    folder = client.post("/api/nodes", {"kind": "folder", "title": "Keller", "space": "karte"}, format="json").json()
    m = create(client, "map", "Rack Keller", folder["id"])
    area = create(client, "area", "IT")
    assert "Keller" not in [n["title"] for n in client.get("/api/tree").json()]
    assert "Keller" in [n["title"] for n in client.get("/api/tree?space=karte").json()]
    assert client.post("/api/nodes", {"kind": "page", "title": "x", "parent": folder["id"]}, format="json").status_code == 400
    assert client.post("/api/nodes", {"kind": "map", "title": "x", "parent": area}, format="json").status_code == 400
    assert client.patch(f"/api/nodes/{m}", {"parent": area}, format="json").status_code == 400
    assert client.patch(f"/api/nodes/{m}", {"parent": None}, format="json").status_code == 200  # top level is fine
    up = SimpleUploadedFile("a.txt", b"x")
    assert client.post("/api/files", {"parent": folder["id"], "file": up}).status_code == 400


def test_map_save_history_and_status(client, monkeypatch):
    from . import services
    folder = client.post("/api/nodes", {"kind": "folder", "title": "F", "space": "karte"}, format="json").json()
    m = create(client, "map", "Karte", folder["id"])
    assert client.put(f"/api/pages/{m}/content", {"content": {}, "base_version": 1}, format="json").status_code == 400
    elements = [{"id": "a", "type": "device", "check": "tcp://10.0.0.1:22"},
                {"id": "b", "type": "device", "check": "tcp://10.0.0.2"},  # no port: ignored, not a server error
                {"id": "c", "type": "text", "text": "Hallo"}]
    r = client.put(f"/api/pages/{m}/content", {"content": {"elements": elements}, "base_version": 1}, format="json")
    assert r.status_code == 200 and r.json()["version"] == 2 and r.json()["content"]["elements"] == elements
    client.put(f"/api/pages/{m}/content", {"content": {"elements": []}, "base_version": 2}, format="json")
    revs = client.get(f"/api/nodes/{m}/history").json()
    assert len(revs) == 2
    restored = client.post(f"/api/nodes/{m}/history/{revs[1]['id']}/restore").json()
    assert restored["content"]["elements"] == elements
    monkeypatch.setattr(services, "is_up", lambda url: url == "tcp://10.0.0.1:22")
    services._cache.clear()
    assert APIClient().get(f"/api/maps/{m}/status").status_code == 404
    assert client.get(f"/api/maps/{m}/status").json() == {"a": True}
    assert client.get(f"/api/maps/{folder['id']}/status").status_code == 404


def test_from_karte_json():
    from .maps import from_karte_json
    content = from_karte_json({"rack": {"name": "R", "units": 4}, "devices": [
        {"id": "sw", "name": "Switch X", "rack": {"u": 4, "h": 1}},
        {"id": "pc", "name": "PC", "check": "http://pc", "uplink": "sw", "port": "Port 1"}]})
    by_id = {e["id"]: e for e in content["elements"]}
    assert by_id["sw"]["type"] == "switch" and by_id["sw"]["rack"] == {"id": "rack", "u": 4, "h": 1}
    assert by_id["pc"]["type"] == "device" and "rack" not in by_id["pc"]
    assert by_id["link-pc"] == {"id": "link-pc", "type": "link", "from": "pc", "to": "sw", "label": "Port 1", "color": ""}


def test_tcp_check_and_shared_cache(monkeypatch):
    import socket
    from . import services
    services._cache.clear()
    calls = []
    monkeypatch.setattr(socket, "create_connection", lambda addr, timeout: calls.append(addr) or socket.socket())
    assert services.check_all(["tcp://10.0.0.1:22"]) == {"tcp://10.0.0.1:22": True}
    services.check_all(["tcp://10.0.0.1:22", "tcp://10.0.0.1:22"])
    assert calls == [("10.0.0.1", 22)]  # second call served from cache


def test_map_page_links(client):
    area = create(client, "area", "Handbücher")
    page = create(client, "page", "Proxmox", area)
    pages = client.get("/api/pages").json()
    assert {"id": page, "title": "Proxmox", "path": "Handbücher"} in pages
    assert APIClient().get("/api/pages").status_code == 404
    folder = client.post("/api/nodes", {"kind": "folder", "title": "F", "space": "karte"}, format="json").json()
    m = create(client, "map", "Rack", folder["id"])
    elements = [{"id": "pve", "type": "device", "name": "PVE1", "page": page}, {"id": "x", "type": "device", "name": "X"}]
    client.put(f"/api/pages/{m}/content", {"content": {"elements": elements}, "base_version": 1}, format="json")
    assert client.get(f"/api/nodes/{page}/maps").json() == [{"id": m, "kind": "map", "title": "Rack", "elements": [{"id": "pve", "name": "PVE1"}]}]
    client.delete(f"/api/nodes/{m}")
    assert client.get(f"/api/nodes/{page}/maps").json() == []


def _zip(parts):
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, xml in parts.items():
            z.writestr(name, xml)
    return buf.getvalue()


def _pdf(text):
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
            b"/Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (i, o)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)


def test_search_pages_files_and_visibility(client):
    from django.core.files.uploadedfile import SimpleUploadedFile
    area = create(client, "area", "IT")
    folder = create(client, "folder", "Alt", area)
    page = create(client, "page", "Router", area)
    client.put(f"/api/pages/{page}/content", {"html": "<p>Die Firewallregeln</p><p>schützen das Netzwerk.</p>",
                                               "base_version": 1}, format="json")
    files = {
        "plan.docx": _zip({"word/document.xml": "<w:p><w:t>Notstromaggregat</w:t><w:t>Wartung</w:t></w:p>"}),
        "liste.xlsx": _zip({"xl/sharedStrings.xml": "<sst><si><t>Seriennummer</t></si><si><t>Zugangspunkt</t></si></sst>"}),
        "handbuch.pdf": _pdf("Druckerwartung Quartal"),
        "netz.drawio": b'<mxfile><diagram><mxCell value="Switch &lt;b&gt;10.99.1.6&lt;/b&gt;"/></diagram></mxfile>',
        "kaputt.pdf": b"not a pdf",
    }
    for name, data in files.items():
        r = client.post("/api/files", {"parent": area, "file": SimpleUploadedFile(name, data)}, format="multipart")
        assert r.status_code == 201, r.content
    hidden = create(client, "page", "Firewallregeln alt", folder)

    def titles(q):
        return [h["title"] for h in client.get("/api/search", {"q": q}).json()]

    hits = client.get("/api/search", {"q": "firewallregel netzw"}).json()
    assert [h["title"] for h in hits] == ["Router"]  # German stemming plus prefix, all words required
    assert "\x02Firewallregeln\x03" in hits[0]["snippet"] and hits[0]["path"] == "IT"
    assert titles("notstrom") == ["plan.docx"]
    assert titles("zugangspunkt") == ["liste.xlsx"]
    assert titles("druckerwartung") == ["handbuch.pdf"]
    assert titles("10.99.1.6") == ["netz.drawio"]
    assert set(titles("firewallregeln")) == {"Router", "Firewallregeln alt"}  # title-only match counts
    assert client.delete(f"/api/nodes/{folder}").status_code == 204
    assert titles("firewallregeln") == ["Router"]  # deleted parent hides the child
    assert hidden not in [h["id"] for h in client.get("/api/search", {"q": "alt"}).json()]
    assert APIClient().get("/api/search", {"q": "router"}).json() == []
    for q in ["", "&|!():*'", "' | 'x"]:
        assert client.get("/api/search", {"q": q}).status_code == 200


def test_new_file_version_replaces_search_text(client):
    from django.core.files.uploadedfile import SimpleUploadedFile
    area = create(client, "area", "IT")
    node = client.post("/api/files", {"parent": area, "file": SimpleUploadedFile("a.txt", b"Kaffeemaschine")},
                       format="multipart").json()["id"]
    client.post(f"/api/files/{node}/versions", {"file": SimpleUploadedFile("a.txt", b"Teekocher")}, format="multipart")
    assert client.get("/api/search", {"q": "kaffeemaschine"}).json() == []
    assert len(client.get("/api/search", {"q": "teekocher"}).json()) == 1


def test_search_finds_map_elements(client):
    folder = client.post("/api/nodes", {"kind": "folder", "title": "F", "space": "karte"}, format="json").json()
    m = create(client, "map", "Rack", folder["id"])
    elements = [{"id": "sw", "type": "device", "name": "Zyxelschalter", "ip": "10.99.1.7"}, {"id": "c", "type": "cable"}]
    client.put(f"/api/pages/{m}/content", {"content": {"elements": elements}, "base_version": 1}, format="json")
    hits = client.get("/api/search", {"q": "10.99.1.7"}).json()
    assert [(h["id"], h["kind"]) for h in hits] == [(m, "map")]
    rev = client.get(f"/api/nodes/{m}/history").json()[0]["id"]
    assert client.post(f"/api/nodes/{m}/history/{rev}/restore").status_code == 200
    assert len(client.get("/api/search", {"q": "zyxel"}).json()) == 1


def test_network_links_to_drawio(client):
    area = create(client, "area", "Handbücher")
    plan = upload(client, area, "Smart Home.drawio", b"<mxfile/>", "application/xml")["id"]
    other = upload(client, area, "notiz.txt", b"x", "text/plain")["id"]
    page = create(client, "page", "Smart Home", area)
    client.put(f"/api/pages/{page}/content", {"html": f'<div data-drawio="{plan}"></div>', "base_version": 1}, format="json")
    folder = client.post("/api/nodes", {"kind": "folder", "title": "Netzpläne", "space": "karte"}, format="json").json()
    bad = client.post("/api/nodes", {"kind": "link", "parent": folder["id"], "target": other}, format="json")
    assert bad.status_code == 400
    assert client.post("/api/nodes", {"kind": "link", "parent": folder["id"], "target": "nope"}, format="json").status_code == 400
    r = client.post("/api/nodes", {"kind": "link", "parent": folder["id"], "target": plan}, format="json")
    assert r.status_code == 201 and r.json()["title"] == "Smart Home" and r.json()["target"] == plan
    link = r.json()["id"]
    assert client.post("/api/nodes", {"kind": "link", "parent": area, "target": plan}, format="json").status_code == 400
    expected = [{"id": link, "kind": "link", "title": "Smart Home", "elements": []}]
    assert client.get(f"/api/nodes/{page}/maps").json() == expected  # via the embedded diagram
    assert client.get(f"/api/nodes/{plan}/maps").json() == expected  # the file itself
    client.delete(f"/api/nodes/{link}")
    assert client.get(f"/api/nodes/{plan}").status_code == 200  # deleting the shortcut keeps the plan
    assert client.get(f"/api/nodes/{page}/maps").json() == []


def test_onlyoffice_callback_via_alias_and_office_path(client, settings, monkeypatch):
    import io
    from . import files
    settings.WIKI_HOSTS = ["192.0.2.4", "findus.example.org"]
    fetched = []
    monkeypatch.setattr(files.urllib.request, "urlopen", lambda url, timeout: fetched.append(url) or io.BytesIO(b"PK new"))
    node = upload(client, create(client, "area", "IT"), "brief.docx", b"PK")
    cfg = client.get(f"/api/files/{node['id']}/onlyoffice-config?mode=edit").json()["config"]
    path = cfg["editorConfig"]["callbackUrl"].replace("http://web:8000", "")
    saved = jwt.encode({"status": 2, "url": "https://findus.example.org/office/cache/files/k/output.docx?md5=x"}, "test-secret",
                       algorithm="HS256")
    assert client.post(path, {"token": saved}, format="json").json() == {"error": 0}
    assert fetched == ["http://onlyoffice/cache/files/k/output.docx?md5=x"]
    assert len(client.get(f"/api/nodes/{node['id']}").json()["versions"]) == 2


def test_alias_host_allowed(client, settings):
    settings.ALLOWED_HOSTS = ["192.0.2.4", "findus.example.org"]
    assert client.get("/api/health", HTTP_HOST="findus.example.org").status_code == 200
    assert client.get("/api/health", HTTP_HOST="evil.example").status_code == 400


def test_export_markdown_zip_and_permissions(client, monkeypatch):
    import io, zipfile
    area = create(client, "area", "Handbücher")
    folder = create(client, "folder", "Netz/Plan", area)
    img = upload(client, area, "bild.png", b"PNG", "image/png")
    plan = upload(client, folder, "Netz.drawio", b"<mxfile/>", "application/xml")
    page = create(client, "page", "Proxmox", folder)
    html = (f'<h2>Zweck</h2><p>Hypervisor <strong>PVE1</strong></p><img src="/media-dl/{img["versions"][0]["id"]}">'
            f'<div data-drawio="{plan["id"]}"></div>')
    client.put(f"/api/pages/{page}/content", {"html": html, "base_version": 1}, format="json")
    gone = create(client, "page", "Alt", folder)
    client.delete(f"/api/nodes/{gone}")
    r = client.get(f"/api/nodes/{area}/export?type=md")
    assert r.status_code == 200 and r["Content-Type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "Handbücher/bild.png" in names and "Handbücher/Netz_Plan/Netz.drawio" in names
    md = z.read("Handbücher/Netz_Plan/Proxmox.md").decode()
    assert md.startswith("# Proxmox") and "## Zweck" in md and "**PVE1**" in md
    assert "../../_medien/" in md and "Schaubild: Netz.drawio" in md
    assert not any("Alt" in n for n in names)  # deleted pages stay out
    assert sum(n.startswith("_medien/") for n in names) == 2
    assert APIClient().get(f"/api/nodes/{area}/export?type=md").status_code == 404
    assert client.get(f"/api/nodes/{plan['id']}/export").status_code == 400
    monkeypatch.setattr("core.export.can", lambda user, action, node: node.title != "Netz/Plan")
    names = set(zipfile.ZipFile(io.BytesIO(client.get(f"/api/nodes/{area}/export?type=md").content)).namelist())
    assert "Handbücher/bild.png" in names and not any("Proxmox" in n for n in names)  # unreadable subtree skipped


def test_export_pdf_via_onlyoffice(client, monkeypatch, settings):
    import io, json
    from . import export
    area = create(client, "area", "IT")
    page = create(client, "page", "Seite", area)
    client.put(f"/api/pages/{page}/content", {"html": "<p>Hallo</p>", "base_version": 1}, format="json")
    calls = []

    def fake_urlopen(req, timeout):
        if hasattr(req, "data"):  # the ConvertService request
            body = json.loads(req.data)
            calls.append(body)
            token = body["url"].rsplit("/", 1)[1]
            html = client.get(f"/internal/export-html/{token}").getvalue().decode()  # what OnlyOffice would fetch
            assert "<h1>IT</h1>" in html and "Hallo" in html
            return io.BytesIO(json.dumps({"endConvert": True, "fileUrl": "http://onlyoffice/cache/files/x/out.pdf"}).encode())
        calls.append(req)
        return io.BytesIO(b"%PDF-1.7 test")

    monkeypatch.setattr(export.urllib.request, "urlopen", fake_urlopen)
    r = client.get(f"/api/nodes/{area}/export?type=pdf")
    assert r.status_code == 200 and r.content == b"%PDF-1.7 test" and r["Content-Type"] == "application/pdf"
    assert calls[0]["filetype"] == "html" and calls[0]["outputtype"] == "pdf" and calls[1] == "http://onlyoffice/cache/files/x/out.pdf"
    assert not list((settings.MEDIA_ROOT / export.TMP_DIR).iterdir())  # temporary HTML removed
    assert client.get("/internal/export-html/forged").status_code == 404
