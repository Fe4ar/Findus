import pytest
from django.contrib.auth.models import Group, User
from rest_framework.test import APIClient

from .models import Node


@pytest.fixture(autouse=True)
def legacy_groups(db):
    """Migration 0015 removes the empty IT-Team/Leser groups; many tests still use them as plain groups, so recreate them."""
    from .models import NodePermission
    for name, flags in {"IT-Team": (True, True, True, False), "Leser": (True, False, False, False)}.items():
        g, _ = Group.objects.get_or_create(name=name)
        r, w, p, m = flags
        NodePermission.objects.get_or_create(node=None, group=g, defaults=dict(can_read=r, can_write=w, can_publish=p, can_manage=m))


@pytest.fixture
def user(db):
    u = User.objects.create_user("tester", password="x-test-pass-1")
    u.groups.add(Group.objects.get(name="IT-Team"))  # existing accounts were migrated into IT-Team
    return u


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
    assert [n["title"] for n in anon.get("/api/tree").json()] == ["FAQ für Anwender"]  # only the public area
    assert anon.get(f"/api/nodes/{page}").status_code == 404
    assert anon.get(f"/api/nodes/{page}/history").status_code == 404
    assert anon.put(f"/api/pages/{page}/content", {"html": "x", "base_version": 1}, format="json").status_code == 404


def test_tree_and_breadcrumb(client):
    area = create(client, "area", "IT")
    folder = create(client, "folder", "Server", area)
    page = create(client, "page", "Proxmox", folder)
    assert [n["title"] for n in client.get("/api/tree").json()] == ["FAQ für Anwender", "IT"]  # FAQ from migration 0005
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


# --- Rechte, Gruppen, öffentlicher Bereich, Audit-Log ----------------------------------------------------------

def _member(name, group=None):
    u = User.objects.create_user(name, password="x-test-pass-1")
    if group:
        u.groups.add(Group.objects.get(name=group))
    c = APIClient()
    c.force_login(u)
    return u, c


def _grant(client, node, group, **flags):
    rows = [{"group": Group.objects.get(name=group).id, **flags}]
    r = client.put(f"/api/nodes/{node}/permissions", {"rows": rows}, format="json")
    assert r.status_code == 200, r.content


@pytest.fixture
def admin(db):
    u = User.objects.create_superuser("chef", password="x-test-pass-1")
    c = APIClient()
    c.force_login(u)
    return c


def test_migration_groups_and_public_faq(db):
    from .models import NodePermission
    flags = {p.group.name: (p.can_read, p.can_write, p.can_publish, p.can_manage)
             for p in NodePermission.objects.filter(node=None).select_related("group")}
    assert flags == {"Admin": (True, True, True, True), "IT-Team": (True, True, True, False),
                     "Leser": (True, False, False, False)}
    faq = Node.objects.get(parent=None, title="FAQ für Anwender")
    assert faq.is_public and faq.children.get().status == "published"


def test_inheritance_is_union_over_ancestors(admin, db):
    Group.objects.create(name="Technik")
    area = create(admin, "area", "IT")
    folder = create(admin, "folder", "Server", area)
    page = create(admin, "page", "Proxmox", folder)
    other = create(admin, "page", "Andere", create(admin, "area", "Personal"))
    _, c = _member("tom", "Technik")
    assert c.get(f"/api/nodes/{page}").status_code == 404  # no rights at all: invisible
    _grant(admin, area, "Technik", can_read=True)
    _grant(admin, folder, "Technik", can_read=True, can_write=True)
    assert c.get(f"/api/nodes/{page}").json()["permissions"] == {"read": True, "write": True, "publish": False, "manage": False}
    assert c.get(f"/api/nodes/{area}").json()["permissions"]["write"] is False
    assert c.patch(f"/api/nodes/{area}", {"title": "x"}, format="json").status_code == 403  # readable, not writable
    assert c.get(f"/api/nodes/{other}").status_code == 404
    assert [n["title"] for n in c.get("/api/tree").json()] == ["FAQ für Anwender", "IT"]  # public areas are open to everyone
    # Writer without publish right: new pages start as drafts and cannot be published by them.
    new = c.post("/api/nodes", {"kind": "page", "title": "Neu", "parent": folder}, format="json").json()
    assert new["status"] == "draft"
    assert c.patch(f"/api/nodes/{new['id']}", {"status": "published"}, format="json").status_code == 403
    assert c.get(f"/api/nodes/{folder}/permissions").status_code == 403  # no manage right
    inherited = {g["name"]: g for g in admin.get(f"/api/nodes/{folder}/permissions").json()["groups"]}
    assert inherited["Technik"]["inherited"]["can_read"] and inherited["Technik"]["own"]["can_write"]
    # Global rights of IT-Team no longer reach nodes (only node=None questions); areas carry their own rows.
    assert inherited["IT-Team"]["inherited"] == {"can_read": False, "can_write": False, "can_publish": False, "can_manage": False}


def test_group_roles(admin, db):
    area = create(admin, "area", "IT")
    page = create(admin, "page", "Proxmox", area)
    draft = create(admin, "page", "Entwurf", area)
    admin.patch(f"/api/nodes/{draft}", {"status": "draft"}, format="json")
    from .models import NodePermission
    NodePermission.objects.create(node_id=area, group=Group.objects.get(name="Leser"))
    NodePermission.objects.create(node_id=area, group=Group.objects.get(name="IT-Team"), can_write=True, can_publish=True)
    _, reader = _member("lisa", "Leser")
    assert reader.get(f"/api/nodes/{page}").status_code == 200
    assert reader.get(f"/api/nodes/{draft}").status_code == 404  # drafts only for writers
    assert reader.put(f"/api/pages/{page}/content", {"html": "x", "base_version": 1}, format="json").status_code == 403
    assert reader.post("/api/nodes", {"kind": "area", "title": "x"}, format="json").status_code == 404
    assert reader.get("/api/services").status_code == 200 and reader.get("/api/board").status_code == 200
    _, it = _member("ina", "IT-Team")
    assert it.post("/api/nodes", {"kind": "area", "title": "Neu"}, format="json").status_code == 201
    assert it.get(f"/api/nodes/{draft}").status_code == 200
    assert it.patch(f"/api/nodes/{draft}", {"status": "published"}, format="json").status_code == 200
    assert it.get(f"/api/nodes/{area}/permissions").status_code == 403
    assert it.patch(f"/api/nodes/{area}", {"is_public": True}, format="json").status_code == 403
    _, nobody = _member("nemo")
    assert [n["title"] for n in nobody.get("/api/tree").json()] == ["FAQ für Anwender"] and nobody.get("/api/services").status_code == 404


def test_anonymous_sees_only_published_public_content(admin, db):
    from django.core.files.uploadedfile import SimpleUploadedFile
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    pub = create(admin, "page", "Drucker einrichten", faq)
    admin.put(f"/api/pages/{pub}/content", {"html": "<p>Druckertreiber Anleitung</p>", "base_version": 1}, format="json")
    draft = create(admin, "page", "Druckertreiber Entwurf", faq)
    admin.patch(f"/api/nodes/{draft}", {"status": "draft"}, format="json")
    secret = create(admin, "page", "Druckertreiber intern", create(admin, "area", "IT"))
    up = admin.post("/api/files", {"parent": faq, "file": SimpleUploadedFile("faq.txt", b"Druckertreiber")}, format="multipart")
    private = admin.post("/api/files", {"parent": Node.objects.get(title="IT").id,
                                        "file": SimpleUploadedFile("geheim.txt", b"Druckertreiber")}, format="multipart")
    anon = APIClient()
    assert [n["title"] for n in anon.get("/api/tree").json()] == ["FAQ für Anwender"]
    assert anon.get(f"/api/nodes/{pub}").status_code == 200
    assert anon.get(f"/api/nodes/{pub}").json()["permissions"] == {"read": True, "write": False, "publish": False, "manage": False}
    for node in (draft, secret):
        assert anon.get(f"/api/nodes/{node}").status_code == 404
        assert anon.get(f"/api/nodes/{node}/history").status_code == 404
    assert anon.put(f"/api/pages/{pub}/content", {"html": "x", "base_version": 2}, format="json").status_code == 403
    assert anon.post("/api/nodes", {"kind": "page", "title": "x", "parent": faq}, format="json").status_code == 403
    assert sorted(h["title"] for h in anon.get("/api/search", {"q": "druckertreiber"}).json()) == ["Drucker einrichten", "faq.txt"]
    assert anon.get(up.json()["versions"][0]["url"]).status_code == 200
    assert anon.get(private.json()["versions"][0]["url"]).status_code == 404
    for path in ("/api/services", "/api/board", "/api/pages", f"/api/nodes/{faq}/permissions"):
        assert anon.get(path).status_code in (403, 404), path
    # Withdrawing publication or the public flag hides it again.
    admin.patch(f"/api/nodes/{faq}", {"is_public": False}, format="json")
    assert anon.get(f"/api/nodes/{pub}").status_code == 404 and anon.get("/api/tree").json() == []


def test_audit_log(admin, db, client):
    from .models import AuditLog
    area = create(admin, "area", "IT")
    folder = create(admin, "folder", "A", area)
    admin.patch(f"/api/nodes/{folder}", {"title": "B"}, format="json")
    admin.patch(f"/api/nodes/{folder}", {"parent": create(admin, "area", "Ziel")}, format="json")
    _grant(admin, area, "Leser", can_read=True)
    admin.delete(f"/api/nodes/{folder}")
    APIClient().post("/api/auth/login", {"username": "chef", "password": "falsch"}, format="json",
                     HTTP_X_FORWARDED_FOR="198.51.100.20, 192.0.2.32")
    APIClient().post("/api/auth/login", {"username": "chef", "password": "x-test-pass-1"}, format="json")
    log = list(AuditLog.objects.order_by("id").values_list("action", "node_title", "username"))
    assert [a for a, _, _ in log] == ["create", "create", "update", "create", "move", "permissions", "delete",
                                      "login_failed", "login"]
    assert log[2][1] == "B" and log[-1][2] == "chef"
    failed = AuditLog.objects.get(action="login_failed")
    assert failed.ip == "198.51.100.20" and failed.user is None and failed.username == "chef"
    assert AuditLog.objects.get(action="permissions").details["after"] == {
        "Leser": {"can_read": True, "can_write": False, "can_publish": False, "can_manage": False}}


def test_theme_setting_per_user(client, db):
    assert client.get("/api/auth/me").json()["theme"] == "auto"
    assert client.put("/api/auth/settings", {"theme": "dark"}, format="json").json()["theme"] == "dark"
    assert client.get("/api/auth/me").json()["theme"] == "dark"
    assert client.put("/api/auth/settings", {"theme": "pink"}, format="json").status_code == 400
    assert APIClient().put("/api/auth/settings", {"theme": "dark"}, format="json").status_code == 403


def test_karte_areas(client):
    # Migration 0007: the seeded test map sits in the area "Heimnetz" now.
    heim = Node.objects.get(space="karte", kind="area", title="Heimnetz", parent=None)
    assert Node.objects.get(space="karte", kind="map", title="Testkarte").ancestors()[0] == heim
    area = client.post("/api/nodes", {"kind": "area", "title": "Büro", "space": "karte"}, format="json").json()
    assert area["space"] == "karte"
    folder = create(client, "folder", "Serverraum", area["id"])
    create(client, "map", "Rack 1", folder)
    create(client, "map", "Übersicht", area["id"])  # maps directly in an area are fine
    assert client.post("/api/nodes", {"kind": "area", "title": "x", "parent": folder}, format="json").status_code == 400
    assert [n["title"] for n in client.get(f"/api/tree?parent={area['id']}").json()] == ["Serverraum", "Übersicht"]
    assert "Büro" not in [n["title"] for n in client.get("/api/tree").json()]
    # Only wiki areas can be public.
    assert client.patch(f"/api/nodes/{area['id']}", {"is_public": True}, format="json").status_code in (400, 403)


# --- v0.6: teams, rights per folder, download right, trash, audit ----------------------------------------------

def _team(admin, name, leader, members=()):
    rows = [{"user": leader.id, "is_leader": True}] + [{"user": u.id, "can_write": w} for u, w in members]
    r = admin.post("/api/teams", {"name": name, "members": rows}, format="json")
    assert r.status_code == 201, r.content
    return r.json()


def test_team_area_visible_only_to_members(admin, db):
    lead, lc = _member("lea")
    reader, rc = _member("rudi")
    writer, wc = _member("willi")
    _, other = _member("ida", "IT-Team")  # global IT-Team rights must not reach a team area
    team = _team(admin, "Netz", lead, [(reader, False), (writer, True)])
    area = team["area"]
    page = create(lc, "page", "Intern", area)
    assert rc.get(f"/api/nodes/{page}").status_code == 200
    assert rc.put(f"/api/pages/{page}/content", {"html": "x", "base_version": 1}, format="json").status_code == 403
    assert wc.put(f"/api/pages/{page}/content", {"html": "x", "base_version": 1}, format="json").status_code == 200
    assert other.get(f"/api/nodes/{page}").status_code == 404
    assert [n["title"] for n in other.get("/api/tree").json()] == [] or "Netz" not in [n["title"] for n in other.get("/api/tree").json()]
    assert any(n["title"] == "Netz" for n in admin.get("/api/tree").json())
    # Leader: may change the write right of a member, nothing else.
    r = lc.patch(f"/api/teams/{team['id']}", {"members": [{"user": lead.id, "is_leader": True}, {"user": reader.id, "can_write": True},
                                                       {"user": writer.id, "can_write": True}]}, format="json")
    assert r.status_code == 200
    assert rc.put(f"/api/pages/{page}/content", {"html": "y", "base_version": 2}, format="json").status_code == 200
    assert lc.patch(f"/api/teams/{team['id']}", {"members": [{"user": lead.id, "is_leader": True}]}, format="json").status_code == 403
    assert lc.post("/api/teams", {"name": "X", "members": []}, format="json").status_code == 403
    assert wc.patch(f"/api/teams/{team['id']}", {"trash_days": 5}, format="json").status_code == 404  # writer is not a leader


def test_download_right(admin, db):
    from django.core.files.uploadedfile import SimpleUploadedFile
    area = create(admin, "area", "Doku")
    f = admin.post("/api/files", {"parent": area, "file": SimpleUploadedFile("a.txt", b"hallo")}, format="multipart").json()
    from .models import NodePermission
    NodePermission.objects.create(node_id=area, group=Group.objects.get(name="Leser"))
    u, c = _member("lisa", "Leser")
    url = f["versions"][0]["url"]
    assert c.get(url + "?download=1").status_code == 200
    assert admin.patch(f"/api/admin/users/{u.id}", {"can_download": False}, format="json").status_code == 200
    assert c.get(url + "?download=1").status_code == 403
    assert c.get(url).status_code == 200  # inline (images in pages) stays
    assert c.get(f"/api/nodes/{area}/export?type=md").status_code == 403
    assert c.get("/api/auth/me").json()["can_download"] is False
    assert c.get("/api/admin/users").status_code == 403


def test_rights_per_folder(admin, db):
    area = create(admin, "area", "Doku")
    sub = create(admin, "folder", "Drucker", area)
    _, it = _member("ina", "IT-Team")
    from .models import NodePermission
    NodePermission.objects.create(node_id=area, group=Group.objects.get(name="IT-Team"), can_write=True)
    data = admin.get("/api/admin/folders").json()
    row = {r["title"]: r for r in data["rows"]}
    assert row["Doku"]["vis"]["badge"] == "Nur IT-Team" and row["Drucker"]["inherit"] is True
    assert row["Drucker"]["vis"]["text"].endswith("(geerbt)")
    g = next(p["key"] for p in data["principals"] if p["label"] == "Leser")
    # "Ohne Anmeldung" exists only inside the FAQ: anywhere else it is refused
    r = admin.put("/api/admin/folders/save", {"rows": [{"id": sub, "inherit": False, "public": True, "cells": {}}]}, format="json")
    assert r.status_code == 400
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    fsub = create(admin, "folder", "Drucker FAQ", faq)
    fpage = create(admin, "page", "Treiber", fsub)
    assert APIClient().get(f"/api/nodes/{fpage}").status_code == 200  # inherited from the public FAQ
    r = admin.put("/api/admin/folders/save", {"faq": True, "rows": [{"id": fsub, "inherit": False, "public": False, "cells": {}}]}, format="json")
    assert r.status_code == 200
    assert APIClient().get(f"/api/nodes/{fpage}").status_code == 404  # a private FAQ folder
    admin.put("/api/admin/folders/save", {"faq": True, "rows": [{"id": fsub, "inherit": True}]}, format="json")
    assert APIClient().get(f"/api/nodes/{fpage}").status_code == 200
    assert [r["title"] for r in admin.get("/api/admin/folders?faq=1").json()["rows"]][:1] == ["FAQ für Anwender"]
    # Team view: a leader sees only the team's area; leaving "erben" keeps the other groups' access
    lead, lc = _member("lea")
    team = _team(admin, "Netz", lead)
    tf = create(lc, "folder", "Intern", team["area"])
    data = lc.get(f"/api/admin/folders?team={team['id']}").json()
    assert [r["title"] for r in data["rows"]] == ["Netz", "Intern"] and [p["label"] for p in data["principals"]] == ["Netz"]
    assert lc.get("/api/admin/folders").status_code == 403 and lc.get("/api/admin/folders?faq=1").status_code == 403
    key = data["principals"][0]["key"]
    r = lc.put("/api/admin/folders/save", {"team": team["id"], "rows": [{"id": tf, "inherit": False, "cells": {key: {"see": True, "edit": False}}}]}, format="json")
    assert r.status_code == 200
    row = {x["title"]: x for x in lc.get(f"/api/admin/folders?team={team['id']}").json()["rows"]}["Intern"]
    assert row["inherit"] is False and row["cells"][key] == {"see": True, "edit": False}
    other = admin.get(f"/api/admin/folders?team={team['id']}").json()  # admin sees every non-FAQ folder for this team
    assert any(r["title"] == "Doku" for r in other["rows"]) and not any(r["title"] == "FAQ für Anwender" for r in other["rows"])


def test_trash_restore_purge_and_audit(admin, db):
    from datetime import timedelta
    from django.core.management import call_command
    from django.utils import timezone
    lead, lc = _member("lea")
    writer, wc = _member("willi")
    team = _team(admin, "Netz", lead, [(writer, True)])
    page = create(lc, "page", "Alt", team["area"])
    assert wc.delete(f"/api/nodes/{page}").status_code == 204
    items = wc.get("/api/trash").json()["items"]
    assert [i["title"] for i in items] == ["Alt"] and items[0]["can_purge"] is False
    assert wc.delete(f"/api/trash/{page}").status_code == 403
    assert wc.post(f"/api/trash/{page}/restore").status_code == 200
    assert wc.get(f"/api/nodes/{page}").status_code == 200
    lc.delete(f"/api/nodes/{page}")
    assert lc.patch(f"/api/teams/{team['id']}", {"trash_days": 3}, format="json").status_code == 200
    Node.objects.filter(pk=page).update(deleted_at=timezone.now() - timedelta(days=2))
    call_command("purge_trash")
    assert Node.objects.filter(pk=page).exists()
    Node.objects.filter(pk=page).update(deleted_at=timezone.now() - timedelta(days=4))
    call_command("purge_trash")
    assert not Node.objects.filter(pk=page).exists()
    # Leader sees the log of the own team only, admin can filter by team.
    mine = lc.get("/api/audit").json()
    assert mine["items"] and all(i["team"] == "Netz" for i in mine["items"])
    assert wc.get("/api/audit").status_code == 403
    assert admin.get(f"/api/audit?team={team['id']}&action=delete").json()["total"] >= 1


def test_dashboard_user_team_global(admin, db):
    from .models import Shortcut, ShortcutCategory
    lead, lc = _member("lea")
    mem, mc = _member("mia")
    team = _team(admin, "Netz", lead, [(mem, False)])
    cat = lc.post("/api/dashboard/categories", {"name": "Dienste", "team": team["id"]}, format="json").json()["id"]
    sc = lc.post("/api/dashboard/shortcuts", {"category": cat, "name": "Switch", "url": "http://198.51.100.6"}, format="json").json()["id"]
    cats = {c["name"]: c for c in mc.get("/api/dashboard").json()["categories"]}
    assert cats["Dienste"]["kind"] == "team" and not cats["Dienste"]["editable"]
    assert mc.delete(f"/api/dashboard/shortcuts/{sc}").status_code == 404  # members cannot delete team shortcuts
    assert mc.post("/api/dashboard/categories", {"name": "X", "team": team["id"]}, format="json").status_code == 404
    assert mc.post("/api/dashboard/categories", {"name": "G", "global": True}, format="json").status_code == 403
    own = mc.post("/api/dashboard/categories", {"name": "Privat"}, format="json").json()["id"]
    a = mc.post("/api/dashboard/shortcuts", {"category": own, "name": "A", "url": "https://a.example"}, format="json").json()["id"]
    b = mc.post("/api/dashboard/shortcuts", {"category": own, "name": "B", "url": "https://b.example"}, format="json").json()["id"]
    assert mc.put("/api/dashboard/order", {"shortcuts": {str(own): [b, a]}}, format="json").status_code == 200
    mine = next(c for c in mc.get("/api/dashboard").json()["categories"] if c["name"] == "Privat")
    assert [x["name"] for x in mine["shortcuts"]] == ["B", "A"]
    assert lc.get("/api/dashboard").json()["categories"] and "Privat" not in [c["name"] for c in lc.get("/api/dashboard").json()["categories"]]
    assert mc.post("/api/dashboard/shortcuts", {"category": own, "name": "bad", "url": "javascript:alert(1)"}, format="json").status_code == 400
    assert admin.post("/api/dashboard/categories", {"name": "G", "global": True}, format="json").status_code == 201
    for given, stored in [("192.0.2.1", "http://192.0.2.1"), ("fritz.box:8080", "http://fritz.box:8080"), ("tcp://192.0.2.1:22", "tcp://192.0.2.1:22")]:
        r = mc.post("/api/dashboard/shortcuts", {"category": own, "name": "S", "url": given}, format="json")
        assert r.status_code == 201 and Shortcut.objects.get(pk=r.json()["id"]).url == stored, given


def test_views_stats_and_faq_editors(admin, db):
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    page = create(admin, "page", "Drucker", faq)
    anon = APIClient()
    assert anon.post(f"/api/nodes/{page}/view").status_code == 204
    assert anon.post(f"/api/nodes/{page}/view").status_code == 204  # same viewer within a minute: once
    assert admin.post(f"/api/nodes/{page}/view").status_code == 204
    from .models import PageCounter
    assert PageCounter.objects.get(node_id=page).total == 2
    land = anon.get("/api/faq").json()
    assert land["top"][0]["title"] == "Drucker" and land["top"][0]["views"] == 2
    st = admin.get("/api/stats").json()
    assert st["counts"]["faqs"] >= 1 and st["top7"][0]["title"] == "Drucker" and st["recent"][0]["user"] in ("chef", "anonym")
    assert anon.get("/api/stats").status_code == 403
    assert all(anon.get(u).status_code in (401, 403, 404) for u in ("/api/teams", "/api/trash", "/api/audit", "/api/admin/folders", "/api/admin/users", "/api/dashboard"))
    assert [h["title"] for h in anon.get("/api/search?q=Drucker&faq=1").json()] == ["Drucker"]
    # FAQ editors: without any configured, IT-Team keeps writing; once configured only the named people may.
    lead, lc = _member("lea")
    from .models import NodePermission
    NodePermission.objects.update_or_create(node_id=faq, group=Group.objects.get(name="IT-Team"), defaults=dict(can_read=True, can_write=True, can_publish=True))  # area rows were removed with migration 0015
    it, itc = _member("ina", "IT-Team")
    assert itc.patch(f"/api/nodes/{page}", {"title": "Drucker 2"}, format="json").status_code == 200
    team = _team(admin, "Redaktion", lead, [(it, True)])
    r = admin.put("/api/admin/faq-editors", {"users": [lead.id], "teams": []}, format="json")
    assert r.status_code == 200 and r.json()["restricted"] is True
    assert itc.patch(f"/api/nodes/{page}", {"title": "Drucker 3"}, format="json").status_code == 403  # not named
    assert itc.get(f"/api/nodes/{page}").status_code == 200  # reading stays open
    NodeP = __import__("core.models", fromlist=["NodePermission"]).NodePermission
    NodeP.objects.update_or_create(node_id=faq, group=Group.objects.get(name="Team Redaktion · Schreiben"), defaults=dict(can_read=True, can_write=True, can_publish=True))
    assert lc.patch(f"/api/nodes/{page}", {"title": "Drucker 4"}, format="json").status_code == 200  # named person
    admin.put("/api/admin/faq-editors", {"users": [], "teams": [team["id"]]}, format="json")
    assert itc.patch(f"/api/nodes/{page}", {"title": "Drucker 5"}, format="json").status_code == 200  # whole team named
    assert admin.put("/api/admin/faq-editors", {"users": [it.id + 999], "teams": []}, format="json").status_code == 400
    # Ticket link: only http(s); the public landing data carries it only when a URL is set
    assert anon.get("/api/faq").json()["ticket"] is None
    assert admin.put("/api/admin/faq-editors", {"users": [], "teams": [team["id"]], "ticket_url": "javascript:alert(1)"}, format="json").status_code == 400
    r = admin.put("/api/admin/faq-editors", {"users": [], "teams": [team["id"]], "ticket_url": "https://tickets.example/new?subject={q}", "ticket_label": "Ticket öffnen"}, format="json")
    assert r.status_code == 200 and anon.get("/api/faq").json()["ticket"] == {"url": "https://tickets.example/new?subject={q}", "label": "Ticket öffnen"}
    assert itc.get("/api/admin/faq-editors").status_code == 403


def test_migration_0015_drops_only_empty_legacy_groups(db):
    import importlib
    from django.apps import apps
    from .models import NodePermission
    mig = importlib.import_module("core.migrations.0015_drop_legacy_groups")
    leser = Group.objects.get(name="Leser")
    User.objects.create_user("lena", password="x-test-pass-1").groups.add(leser)
    mig.drop_empty(apps, None)
    assert not Group.objects.filter(name="IT-Team").exists()
    assert not NodePermission.objects.filter(group__name="IT-Team").exists()
    assert Group.objects.filter(name="Leser").exists() and NodePermission.objects.filter(group=leser).exists()
    assert Group.objects.filter(name="Admin").exists()


def test_user_admin_flag_keeps_other_groups(admin, db):
    u = User.objects.create_user("gina", password="x-test-pass-1")
    g_admin, g_leser = Group.objects.get(name="Admin"), Group.objects.get(name="Leser")
    u.groups.add(g_leser)
    r = admin.patch(f"/api/admin/users/{u.id}", {"groups": [g_leser.id, g_admin.id]}, format="json")
    assert r.status_code == 200 and sorted(r.json()["groups"]) == ["Admin", "Leser"]


def test_recent_pages_per_user(admin, db):
    from datetime import timedelta
    from django.utils import timezone
    from .models import PageView
    a = create(admin, "area", "Doku")
    p1, p2, p3 = (create(admin, "page", t, a) for t in ("Eins", "Zwei", "Drei"))
    for pid in (p1, p2, p3):
        assert admin.post(f"/api/nodes/{pid}/view").status_code == 204
    PageView.objects.filter(node_id=p1).update(at=timezone.now() - timedelta(hours=1))
    got = admin.get("/api/recent").json()
    assert [x["title"] for x in got][-1] == "Eins" and {x["title"] for x in got} == {"Eins", "Zwei", "Drei"} and got[0]["area"] == "Doku"
    other, oc = _member("rolf")
    assert oc.get("/api/recent").json() == []  # per user, not global
    assert APIClient().get("/api/recent").status_code in (401, 403, 404)
    admin.delete(f"/api/nodes/{p2}")
    assert "Zwei" not in [x["title"] for x in admin.get("/api/recent").json()]


def test_single_team_area_is_not_shown_as_open_to_all(admin, db):
    Group.objects.filter(name__in=["IT-Team", "Leser"]).delete()  # state after migration 0015
    lead, _ = _member("lea")
    team = _team(admin, "Netz", lead, [])
    row = next(n for n in admin.get("/api/tree").json() if n["id"] == team["area"])
    assert row["vis"]["badge"] == "Nur Netz" and row["vis"]["kind"] == "team"
