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
    assert reader.get("/api/services").status_code == 200
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
    for path in ("/api/services", "/api/pages", f"/api/nodes/{faq}/permissions"):
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


# --- v0.7: folder import/export and Collabora (WOPI) -------------------------------------------------------------

def _file_up(client, parent, path, data=b"hello", name="x.bin"):
    from django.core.files.uploadedfile import SimpleUploadedFile
    return client.post("/api/import", {"parent": parent, "path": path, "file": SimpleUploadedFile(name, data)}, format="multipart")


def test_import_creates_folders_and_files(admin, db):
    area = create(admin, "area", "Doku")
    r = _file_up(admin, area, "Netz/Switch/plan.docx", b"v1")
    assert r.status_code == 201 and r.json()["created"] is True
    again = _file_up(admin, area, "Netz/Switch/plan.docx", b"v2")
    assert again.status_code == 200 and again.json()["id"] == r.json()["id"]  # same path: new version, no duplicate
    node = Node.objects.get(pk=r.json()["id"])
    assert node.file_versions.count() == 2 and "Doku" in [a.title for a in node.ancestors()]
    assert Node.objects.filter(kind="folder", title="Netz").count() == 1


@pytest.mark.parametrize("bad", ["../evil.txt", "a/../../b.txt", "/etc/passwd", "a/..", "", "a\\..\\..\\x"])
def test_import_refuses_path_tricks(admin, db, bad):
    area = create(admin, "area", "Doku")
    assert _file_up(admin, area, bad).status_code == 400
    assert not Node.objects.filter(kind="file").exists()


def test_import_cleans_names_and_needs_write(admin, db):
    area = create(admin, "area", "Doku")
    r = _file_up(admin, area, 'a:b/c*d?.txt')
    assert r.status_code == 201
    assert sorted(Node.objects.filter(kind__in=["file", "folder"], parent__in=[area, *Node.objects.filter(parent=area)]).values_list("title", flat=True)) == ["a_b", "c_d_.txt"]
    other, oc = _member("rolf")
    assert _file_up(oc, area, "x.txt").status_code in (403, 404)
    assert _file_up(admin, area, "x/" * 20 + "y.txt").status_code == 400  # deeper than allowed


def test_export_originals_zip_and_right(admin, db):
    import io, zipfile
    area = create(admin, "area", "Doku")
    _file_up(admin, area, "Netz/plan.txt", b"AAA")
    r = admin.get(f"/api/nodes/{area}/export-originals")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(b"".join(r.streaming_content)))
    assert z.namelist() == ["Doku/Netz/plan.txt"] and z.read("Doku/Netz/plan.txt") == b"AAA"
    from .models import UserSettings
    _grant(admin, area, "Leser", can_read=True)
    lisa, lc = _member("lisa", "Leser")
    assert lc.get(f"/api/nodes/{area}/export-originals").status_code == 200
    UserSettings.objects.update_or_create(user=lisa, defaults={"can_download": False})
    assert lc.get(f"/api/nodes/{area}/export-originals").status_code == 403


def _office_node(admin):
    area = create(admin, "area", "Office")
    node = _file_up(admin, area, "Brief.docx", b"DOCX").json()["id"]
    return Node.objects.get(pk=node)


def test_wopi_token_rights_and_save(admin, db):
    from .wopi import make_token
    from .models import FileVersion
    node = _office_node(admin)
    chef = User.objects.get(username="chef")
    c = APIClient()
    base = f"/wopi/files/{node.id}"
    assert c.get(base).status_code == 401 and c.get(base + "?access_token=junk").status_code == 401
    view, edit = make_token(chef, node, "view"), make_token(chef, node, "edit")
    info = c.get(f"{base}?access_token={view}").json()
    assert info["BaseFileName"] == "Brief.docx" and info["UserCanWrite"] is False and info["DisablePrint"] is False
    assert c.get(f"{base}/contents?access_token={view}").status_code == 200
    assert c.post(f"{base}/contents?access_token={view}", b"x", content_type="application/octet-stream").status_code == 401  # view token cannot write
    other = Node.objects.create(kind="file", title="y.docx", parent=node.parent, space="wiki")
    assert c.get(f"/wopi/files/{other.id}?access_token={edit}").status_code == 401  # token is bound to its file
    assert c.get(f"{base}?access_token={edit}").json()["UserCanWrite"] is True
    h = {"HTTP_X_WOPI_OVERRIDE": "LOCK", "HTTP_X_WOPI_LOCK": "L1"}
    assert c.post(f"{base}?access_token={edit}", **h).status_code == 200
    h2 = {"HTTP_X_WOPI_OVERRIDE": "LOCK", "HTTP_X_WOPI_LOCK": "L2"}
    r = c.post(f"{base}?access_token={edit}", **h2)
    assert r.status_code == 409 and r["X-WOPI-Lock"] == "L1"
    assert c.post(f"{base}/contents?access_token={edit}", b"NEW", content_type="application/octet-stream", HTTP_X_WOPI_LOCK="L2").status_code == 409
    ok = c.post(f"{base}/contents?access_token={edit}", b"NEW", content_type="application/octet-stream", HTTP_X_WOPI_LOCK="L1")
    assert ok.status_code == 200
    node.refresh_from_db()
    top = node.file_versions.first()
    assert top.source == FileVersion.COLLABORA and top.file.read() == b"NEW" and node.file_versions.count() == 2
    assert c.post(f"{base}?access_token={edit}", HTTP_X_WOPI_OVERRIDE="UNLOCK", HTTP_X_WOPI_LOCK="L1").status_code == 200
    assert c.post(f"{base}?access_token={edit}", HTTP_X_WOPI_OVERRIDE="PUT_RELATIVE").status_code == 501


def test_wopi_without_export_right_and_after_revoke(admin, db):
    from .wopi import make_token
    from .models import UserSettings
    node = _office_node(admin)
    _grant(admin, node.parent_id, "IT-Team", can_read=True, can_write=True)
    ina, _ = _member("ina", "IT-Team")
    UserSettings.objects.update_or_create(user=ina, defaults={"can_download": False})
    c = APIClient()
    info = c.get(f"/wopi/files/{node.id}?access_token={make_token(ina, node, 'edit')}").json()
    assert info["DisablePrint"] and info["DisableExport"] and info["HideSaveOption"] and info["UserCanWrite"]
    lea, lc = _member("lea")  # no rights on this area
    assert c.get(f"/wopi/files/{node.id}?access_token={make_token(lea, node, 'view')}").status_code == 401
    assert admin.get(f"/api/files/{node.id}/collabora").status_code == 404  # not configured in tests
# --- v0.7: functions per team, tasks ----------------------------------------------------------------------------

ALL = ["export", "faq", "network", "tasks", "wiki"]


def _features(admin, team, **flags):
    r = admin.patch(f"/api/teams/{team['id']}", {"features": flags}, format="json")
    assert r.status_code == 200, r.content
    return r.json()


def _feats(c):
    return c.get("/api/auth/me").json()["features"]


def test_team_features_admin_only_and_default_on(admin, db):
    lead, lc = _member("lea")
    team = _team(admin, "Netz", lead)
    assert team["features"] == dict.fromkeys(ALL, True)
    assert lc.patch(f"/api/teams/{team['id']}", {"features": {"wiki": False}}, format="json").status_code == 403  # leaders: only tasks + network
    assert _feats(lc) == ALL
    assert admin.patch(f"/api/teams/{team['id']}", {"features": {"nope": False}}, format="json").status_code == 400
    assert _features(admin, team, tasks=False)["features"]["tasks"] is False
    assert _feats(lc) == ["export", "faq", "network", "wiki"]


def test_leader_switches_tasks_and_network_for_the_team_members_cannot(admin, db):
    lead, lc = _member("lea")
    mem, mc = _member("max")
    team = _team(admin, "Netz", lead)
    admin.patch(f"/api/teams/{team['id']}", {"members": [{"user": lead.id, "is_leader": True}, {"user": mem.id}]}, format="json")
    url = f"/api/teams/{team['id']}"
    assert mc.patch(url, {"features": {"tasks": False}}, format="json").status_code in (403, 404)
    assert _feats(mc) == ALL
    r = lc.patch(url, {"features": {"tasks": False, "network": False}}, format="json")
    assert r.status_code == 200 and not r.json()["features"]["tasks"] and not r.json()["features"]["network"]
    assert _feats(mc) == ["export", "faq", "wiki"]
    assert mc.get("/api/tasks").status_code in (403, 404)
    assert lc.patch(url, {"features": {"tasks": True}}, format="json").status_code == 200
    assert "tasks" in _feats(mc)


def test_user_has_union_of_team_features_admin_and_teamless_have_all(admin, db):
    a, ac = _member("ann")
    b, bc = _member("bob")
    _, nc = _member("nina")
    t1 = _team(admin, "Eins", a)
    t2 = _team(admin, "Zwei", a, [(b, False)])
    _features(admin, t1, tasks=False, export=False)
    _features(admin, t2, tasks=False, wiki=False)
    assert _feats(ac) == ["export", "faq", "network", "wiki"]  # Eins offers wiki, Zwei offers export
    assert _feats(bc) == ["export", "faq", "network"]
    assert _feats(nc) == ["export", "faq"] and _feats(admin) == ALL  # no team, no rights: only the FAQ


def test_disabled_functions_close_the_matching_parts(admin, db):
    lead, lc = _member("lea")
    team = _team(admin, "Netz", lead)
    page = create(lc, "page", "Intern", team["area"])
    mapfolder = admin.post("/api/nodes", {"kind": "folder", "title": "Netz", "space": "karte"}, format="json").json()["id"]
    admin.post("/api/nodes", {"kind": "map", "title": "Plan", "parent": mapfolder}, format="json")
    from .models import NodePermission
    NodePermission.objects.create(node_id=mapfolder, group=Group.objects.get(pk=team_group(team, "read_group")), can_read=True)
    assert lc.get(f"/api/nodes/{page}").status_code == 200
    assert [n["title"] for n in lc.get("/api/tree?space=karte").json()] == ["Netz"]
    _features(admin, team, wiki=False, network=False, faq=False, export=False)
    assert lc.get(f"/api/nodes/{page}").status_code == 404
    assert lc.get("/api/tree?space=karte").json() == []
    assert lc.get("/api/tree").json() == []  # no team area, no public FAQ
    assert lc.get(f"/api/nodes/{page}/export?type=pdf").status_code == 404
    assert admin.get(f"/api/nodes/{page}").status_code == 200
    _features(admin, team, wiki=True)
    assert lc.get(f"/api/nodes/{page}").status_code == 200
    assert lc.get(f"/api/nodes/{page}/export?type=md").status_code == 403  # export still off: no download right


def team_group(team, attr):
    from .models import Team
    return getattr(Team.objects.get(pk=team["id"]), f"{attr}_id")


def test_tasks_own_colleagues_private_and_rights(admin, db):
    a, ac = _member("ann")
    b, bc = _member("bob")
    s, sc = _member("sam")  # in no shared team
    _team(admin, "Eins", a, [(b, False)])
    _team(admin, "Zwei", s, [])
    r = ac.post("/api/tasks", {"title": "Backup prüfen", "due": "2020-01-01"}, format="json")
    assert r.status_code == 201 and r.json()["mine"] and r.json()["overdue"] and r.json()["editable"]
    mine = r.json()["id"]
    private = ac.post("/api/tasks", {"title": "Geheim", "private": True}, format="json").json()["id"]
    for_bob = ac.post("/api/tasks", {"title": "Drucker", "user": b.id}, format="json").json()
    assert for_bob["owner"]["id"] == b.id and for_bob["created_by"] == "ann"
    assert ac.post("/api/tasks", {"title": "x", "user": s.id}, format="json").status_code == 400  # not a colleague
    assert [p["name"] for p in ac.get("/api/tasks/people").json()] == ["bob"] and sc.get("/api/tasks/people").json() == []
    assert ac.post("/api/tasks", {"title": " "}, format="json").status_code == 400
    assert ac.post("/api/tasks", {"title": "x", "due": "morgen"}, format="json").status_code == 400
    ids = lambda c, q="": [t["title"] for t in c.get("/api/tasks" + q).json()]
    assert ids(bc) == ["Drucker"]  # own only by default
    assert ids(bc, "?colleagues=1") == ["Backup prüfen", "Drucker"] and "Geheim" not in ids(bc, "?colleagues=1")
    assert ids(sc, "?colleagues=1") == []
    assert ids(ac, "?colleagues=1") == ["Backup prüfen", "Drucker", "Geheim"]  # soonest due first, then newest
    # Only owner, creator and admins change a task; others cannot even see private ones.
    assert bc.patch(f"/api/tasks/{mine}", {"done": True}, format="json").status_code == 403
    assert bc.patch(f"/api/tasks/{private}", {"done": True}, format="json").status_code == 404
    assert sc.patch(f"/api/tasks/{mine}", {"done": True}, format="json").status_code == 404
    assert bc.patch(f"/api/tasks/{for_bob['id']}", {"done": True}, format="json").json()["done"] is True  # owner
    assert ac.patch(f"/api/tasks/{for_bob['id']}", {"title": "Drucker tauschen"}, format="json").status_code == 200  # creator
    assert ids(bc) == ["Drucker tauschen"]  # done tasks stay for 14 days
    assert admin.patch(f"/api/tasks/{mine}", {"done": False, "notes": "n"}, format="json").status_code == 200
    assert bc.delete(f"/api/tasks/{mine}").status_code == 403
    assert ac.delete(f"/api/tasks/{mine}").status_code == 204
    assert APIClient().get("/api/tasks").status_code == 403


def test_task_sections_move_and_order(admin, db):
    from .models import Task, TaskSection
    a, ac = _member("ann")
    b, bc = _member("bob")
    _team(admin, "Eins", a, [(b, False)])
    new = lambda c, title, **kw: c.post("/api/tasks", {"title": title, **kw}, format="json").json()["id"]
    t1, t2, t3 = new(ac, "Eins"), new(ac, "Zwei"), new(ac, "Drei")
    s1 = ac.post("/api/tasks/sections", {"title": "Woche"}, format="json").json()["id"]
    s2 = ac.post("/api/tasks/sections", {"title": "Später"}, format="json").json()["id"]
    assert ac.post("/api/tasks/sections", {"title": " "}, format="json").status_code == 400
    assert [s["title"] for s in ac.get("/api/tasks/sections").json()] == ["Woche", "Später"] and bc.get("/api/tasks/sections").json() == []
    # Sections are private to their user: others get 404 for rename, delete, move and as a target.
    assert bc.patch(f"/api/tasks/sections/{s1}", {"title": "x"}, format="json").status_code == 404
    assert bc.delete(f"/api/tasks/sections/{s1}").status_code == 404
    bt = new(bc, "Bobs")
    assert bc.post(f"/api/tasks/{bt}/move", {"section": s1}, format="json").status_code == 400
    assert ac.post(f"/api/tasks/{bt}/move", {"section": s1}, format="json").status_code == 404  # not Ann's task
    # Move between sections and inside one; the order is stored.
    order = lambda sec: [t["title"] for t in ac.get("/api/tasks").json() if t["section"] == sec]
    assert ac.post(f"/api/tasks/{t3}/move", {"section": s1, "before": None}, format="json").status_code == 200
    assert ac.post(f"/api/tasks/{t1}/move", {"section": s1, "before": t3}, format="json").status_code == 200
    assert ac.post(f"/api/tasks/{t2}/move", {"section": s1, "before": t3}, format="json").status_code == 200
    assert order(s1) == ["Eins", "Zwei", "Drei"] and order(None) == []
    assert ac.post(f"/api/tasks/{t3}/move", {"section": s1, "before": t1}, format="json").status_code == 200
    assert order(s1) == ["Drei", "Eins", "Zwei"]
    assert ac.post(f"/api/tasks/{t1}/move", {"section": s1, "before": 999999}, format="json").status_code == 400
    # A move is no edit: Todoist's "later change wins" compares updated_at.
    before = Task.objects.get(pk=t1).updated_at
    ac.post(f"/api/tasks/{t1}/move", {"section": s2}, format="json")
    assert Task.objects.get(pk=t1).updated_at == before and order(s2) == ["Eins"]
    # Sections reorder; deleting one keeps its tasks.
    assert [s["title"] for s in ac.post(f"/api/tasks/sections/{s2}/move", {"before": s1}, format="json").json()] == ["Später", "Woche"]
    assert ac.patch(f"/api/tasks/sections/{s2}", {"title": "Irgendwann"}, format="json").json()["title"] == "Irgendwann"
    assert ac.delete(f"/api/tasks/sections/{s1}").status_code == 204
    assert order(None) == ["Drei", "Zwei"] or sorted(order(None)) == ["Drei", "Zwei"]
    assert TaskSection.objects.filter(user=a).count() == 1
    assert APIClient().get("/api/tasks/sections").status_code == 403


def test_tasks_off_for_team_and_old_done_tasks_hidden(admin, db):
    from datetime import timedelta
    from django.utils import timezone
    from .models import Task
    a, ac = _member("ann")
    team = _team(admin, "Eins", a)
    old = ac.post("/api/tasks", {"title": "Alt"}, format="json").json()["id"]
    Task.objects.filter(pk=old).update(done_at=timezone.now() - timedelta(days=30))
    assert ac.get("/api/tasks").json() == [] and len(ac.get("/api/tasks?done=1").json()) == 1
    _features(admin, team, tasks=False)
    assert ac.get("/api/tasks").status_code == 403 and ac.post("/api/tasks", {"title": "x"}, format="json").status_code == 403


# --- v0.7: navigation per team, public help portal --------------------------------------------------------------

def _publish_text(c, page, html):
    r = c.put(f"/api/pages/{page}/content", {"html": html, "base_version": 1}, format="json")
    assert r.status_code == 200, r.content


def test_public_portal_serves_only_published_pages_of_public_areas(admin, db):
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    folder = create(admin, "folder", "Drucker", faq)
    ok = create(admin, "page", "Drucker einrichten", folder)
    _publish_text(admin, ok, "<p>Druckertreiber Anleitung</p>")
    draft = create(admin, "page", "Druckertreiber Entwurf", faq)
    admin.patch(f"/api/nodes/{draft}", {"status": "draft"}, format="json")
    gone = create(admin, "page", "Druckertreiber alt", faq)
    admin.delete(f"/api/nodes/{gone}")
    private_area = create(admin, "area", "Intern")
    private = create(admin, "page", "Druckertreiber intern", private_area)
    lead, _ = _member("lea")
    team = _team(admin, "Netz", lead)
    team_page = create(admin, "page", "Druckertreiber Team", team["area"])
    anon = APIClient()
    r = anon.get(f"/api/public/pages/{ok}")
    assert r.status_code == 200 and r.json()["title"] == "Drucker einrichten" and "Anleitung" in r.json()["content_html"]
    assert [b["title"] for b in r.json()["breadcrumb"]] == ["Drucker"]  # the area itself is not part of the portal
    for hidden in (draft, gone, private, team_page, folder, faq, "00000000-0000-0000-0000-000000000000"):
        assert anon.get(f"/api/public/pages/{hidden}").status_code == 404, hidden
        assert admin.get(f"/api/public/pages/{hidden}").status_code == 404, hidden  # even a logged-in admin sees the portal view
    assert [h["title"] for h in anon.get("/api/public/search", {"q": "druckertreiber"}).json()] == ["Drucker einrichten"]
    landing = anon.get("/api/public/faq").json()
    assert {p["title"] for p in landing["recent"]} == {"Drucker einrichten", "Willkommen"} and landing["categories"][0]["title"] == "Drucker"
    assert not any(t in str(landing) for t in ("intern", "Team", "Entwurf"))
    for method in ("post", "put", "patch", "delete"):
        assert getattr(anon, method)(f"/api/public/pages/{ok}").status_code == 405
    assert anon.get(f"/api/public/pages/{ok}").status_code == 200 and anon.get(f"/api/public/pages/{ok}").json()["id"] == ok


def test_public_portal_counts_views_and_nothing_else_is_reachable(admin, db):
    from .models import PageCounter
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    page = create(admin, "page", "Hilfe", faq)
    anon = APIClient()
    anon.get(f"/api/public/pages/{page}")
    assert PageCounter.objects.get(node_id=page).total == 1
    assert anon.get("/api/public/faq").json()["top"][0]["title"] == "Hilfe"
    # The portal's API gives no way to enumerate anything else.
    assert anon.get("/api/public/tree").status_code == 404 and anon.get("/api/public/nodes").status_code == 404
    assert anon.get("/api/public/search", {"q": ""}).json() == []


def test_nav_data_teams_other_areas_and_tree_scopes(admin, db):
    a, ac = _member("ann")
    _, nc = _member("nina")
    team = _team(admin, "Netz", a)
    _team(admin, "Büro", _member("bob")[0])
    create(admin, "area", "Handbücher")
    nav = ac.get("/api/auth/me").json()["nav"]
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    assert nav == {"teams": [{"id": team["id"], "name": "Netz", "area": team["area"], "write": True}], "other": False, "public_areas": [faq]}
    assert nc.get("/api/auth/me").json()["nav"] == {"teams": [], "other": False, "public_areas": [faq]}
    adm = admin.get("/api/auth/me").json()["nav"]
    assert [t["name"] for t in adm["teams"]] == ["Büro", "Netz"] and adm["other"] is True
    titles = lambda c, s: [n["title"] for n in c.get(f"/api/tree?scope={s}").json()]
    assert titles(admin, "public") == ["FAQ für Anwender"]
    assert titles(admin, "other") == ["Handbücher"]  # neither public nor a team area
    assert titles(ac, "public") == ["FAQ für Anwender"] and titles(ac, "other") == []
def test_migration_graph_is_linear():
    """Two branches adding migrations at the same time must be merged into one chain (a split broke a deploy once)."""
    from django.db.migrations.loader import MigrationLoader
    leaves = MigrationLoader(None, ignore_no_migrations=True).graph.leaf_nodes("core")
    assert len(leaves) == 1, leaves


def test_collabora_config_url_is_german(admin, db, settings, monkeypatch):
    from . import wopi
    settings.COLLABORA_UPSTREAM = "collabora.test:9980"
    monkeypatch.setattr(wopi, "_actions", lambda: {("edit", "docx"): "/collabora/browser/x/cool.html", ("view", "docx"): "/collabora/browser/x/cool.html"})
    node = _office_node(admin)
    r = admin.get(f"/api/files/{node.id}/collabora?mode=edit", HTTP_HOST="localhost")
    assert r.status_code == 200 and "lang=de" in r.json()["url"] and "WOPISrc=" in r.json()["url"] and r.json()["token"]


def _plain(name):
    """A user without any team and without global rights."""
    u = User.objects.create_user(name, password="x-test-pass-1")
    c = APIClient()
    c.force_login(u)
    return u, c


def test_user_without_team_or_rights_only_has_the_faq(admin, db):
    _, pc = _plain("paula")
    lead, _ = _member("lea")
    team = _team(admin, "Netz", lead)
    page = create(admin, "page", "Intern", team["area"])
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    fpage = create(admin, "page", "Frage", faq)
    mapf = admin.post("/api/nodes", {"kind": "folder", "title": "Plan", "space": "karte"}, format="json").json()["id"]
    assert pc.get("/api/auth/me").json()["features"] == ["export", "faq"]
    assert pc.get(f"/api/nodes/{fpage}").status_code == 200 and pc.get("/api/faq").status_code == 200  # the FAQ stays readable
    assert pc.get(f"/api/nodes/{page}").status_code == 404 and pc.get(f"/api/nodes/{mapf}").status_code == 404
    assert pc.get("/api/tasks").status_code == 403 and pc.post("/api/tasks", {"title": "x"}, format="json").status_code == 403
    assert pc.post("/api/nodes", {"kind": "area", "title": "x"}, format="json").status_code in (403, 404)
    assert pc.get("/api/search", {"q": "Intern"}).json() == []
    assert admin.get(f"/api/nodes/{page}").status_code == 200  # admins keep everything


def test_user_with_old_global_rights_keeps_all_functions(db):
    c = _member("ina", "IT-Team")[1]  # no team, but rights from the legacy global group
    assert c.get("/api/auth/me").json()["features"] == ALL
    assert c.post("/api/nodes", {"kind": "area", "title": "Alt"}, format="json").status_code == 201


def test_functions_are_enforced_by_the_api_not_only_by_the_navigation(admin, db):
    lead, lc = _member("lea", "IT-Team")  # global write right: only the team's functions can stop this user
    team = _team(admin, "Netz", lead)
    wiki = create(lc, "page", "Seite", team["area"])
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    fpage = create(admin, "page", "Frage", faq)
    # Export off: the page is readable, exporting it is refused (403).
    _features(admin, team, export=False)
    assert lc.get(f"/api/nodes/{wiki}").status_code == 200
    assert lc.get(f"/api/nodes/{wiki}/export?type=md").status_code == 403
    _features(admin, team, export=True)
    assert lc.get(f"/api/nodes/{wiki}/export?type=md").status_code == 200
    # FAQ off: reading and editing the public FAQ stops, and the landing data is empty.
    _features(admin, team, faq=False)
    assert lc.get(f"/api/nodes/{fpage}").status_code == 404
    assert lc.put(f"/api/pages/{fpage}/content", {"html": "x", "base_version": 1}, format="json").status_code == 404
    assert lc.get("/api/faq").json()["categories"] == [] and lc.get("/api/faq").json()["top"] == []
    assert lc.get(f"/api/nodes/{wiki}").status_code == 200  # the other functions are unaffected
    # Wiki off: nothing of the wiki, and no new wiki area although the global right would allow it.
    _features(admin, team, faq=True, wiki=False)
    assert lc.get(f"/api/nodes/{wiki}").status_code == 404
    assert lc.post("/api/nodes", {"kind": "area", "title": "Neu"}, format="json").status_code == 403
    assert lc.put(f"/api/pages/{wiki}/content", {"html": "x", "base_version": 1}, format="json").status_code == 404
    assert lc.get("/api/auth/me").json()["can_create_area"] is False
    # Network off: no maps and no new map folder.
    _features(admin, team, wiki=True)
    mapf = lc.post("/api/nodes", {"kind": "folder", "title": "Plan", "space": "karte"}, format="json").json()["id"]
    assert lc.get(f"/api/nodes/{mapf}").status_code == 200
    _features(admin, team, network=False)
    assert lc.get(f"/api/nodes/{mapf}").status_code == 404
    assert lc.post("/api/nodes", {"kind": "folder", "title": "Neu", "space": "karte"}, format="json").status_code == 403
    assert lc.get("/api/tree?space=karte").json() == []
    # Tasks off: 403 everywhere in the tasks API.
    _features(admin, team, tasks=False)
    assert lc.get("/api/tasks").status_code == 403 and lc.get("/api/tasks/people").status_code == 403
    # Admins keep everything whatever their teams say.
    assert admin.get(f"/api/nodes/{wiki}").status_code == 200 and admin.get("/api/tasks").status_code == 200


def test_ticket_link_is_an_admin_setting_validated_and_the_only_one_in_the_public_api(admin, db):
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    page = create(admin, "page", "Frage", faq)
    anon = APIClient()
    assert anon.get("/api/public/faq").json()["ticket"] is None and anon.get(f"/api/public/pages/{page}").json()["ticket"] is None
    _, user = _member("uli", "IT-Team")
    assert user.put("/api/admin/faq-editors", {"users": [], "teams": [], "ticket_url": "https://t.example/neu"}, format="json").status_code == 403
    assert anon.put("/api/admin/faq-editors", {"users": [], "teams": []}, format="json").status_code in (401, 403)
    for bad in ("javascript:alert(1)", "ftp://t.example/x", "http://", "https:///x", "//t.example/x", "https://t.example/a b", "t.example/neu", "data:text/html,x"):
        r = admin.put("/api/admin/faq-editors", {"users": [], "teams": [], "ticket_url": bad}, format="json")
        assert r.status_code == 400, bad
    url = "https://tickets.example.org/neu?betreff={q}"
    r = admin.put("/api/admin/faq-editors", {"users": [], "teams": [], "ticket_url": url, "ticket_label": "Ticket schreiben"}, format="json")
    assert r.status_code == 200
    ticket = {"url": url, "label": "Ticket schreiben"}
    landing = anon.get("/api/public/faq").json()
    assert landing["ticket"] == ticket and set(landing) == {"ticket", "top", "recent", "categories"}  # no other setting leaves the server
    assert anon.get(f"/api/public/pages/{page}").json()["ticket"] == ticket
    # An empty address switches the field off again.
    admin.put("/api/admin/faq-editors", {"users": [], "teams": [], "ticket_url": ""}, format="json")
    assert anon.get("/api/public/faq").json()["ticket"] is None and anon.get(f"/api/public/pages/{page}").json()["ticket"] is None


def test_named_faq_editor_may_edit_without_other_rights(admin, db):
    """Naming a person or team in the FAQ editors is enough; no group or area rows needed (the old tests hid this)."""
    from .models import Team
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    page = create(admin, "page", "Anleitung", faq)
    lead, lc = _member("lea")
    mem, mc = _member("max")
    other, oc = _member("otto")
    team = _team(admin, "Redaktion", lead, [(mem, False)])
    assert lc.patch(f"/api/nodes/{page}", {"title": "A1"}, format="json").status_code == 403  # nobody named yet, no group rights
    admin.put("/api/admin/faq-editors", {"users": [], "teams": [team["id"]]}, format="json")
    assert lc.patch(f"/api/nodes/{page}", {"title": "A2"}, format="json").status_code == 200  # leader via the named team
    assert mc.patch(f"/api/nodes/{page}", {"title": "A3"}, format="json").status_code == 200  # plain member via the named team
    assert oc.patch(f"/api/nodes/{page}", {"title": "A4"}, format="json").status_code == 403  # not named
    t = Team.objects.get(pk=team["id"]); t.disabled_features = ["faq"]; t.save()
    assert lc.patch(f"/api/nodes/{page}", {"title": "A5"}, format="json").status_code in (403, 404)  # FAQ function explicitly off
    t.disabled_features = []; t.save()
    admin.put("/api/admin/faq-editors", {"users": [other.id], "teams": []}, format="json")
    assert oc.patch(f"/api/nodes/{page}", {"title": "A6"}, format="json").status_code == 200  # named person
    assert lc.patch(f"/api/nodes/{page}", {"title": "A7"}, format="json").status_code == 403


def test_public_titles_only_visible_pages_in_order(admin, db):
    faq = str(Node.objects.get(title="FAQ für Anwender").id)
    a, b_, c = (create(admin, "page", n, faq) for n in ("A", "B", "C"))
    for p in (a, b_, c):
        admin.patch(f"/api/nodes/{p}", {"status": "published"}, format="json")
    secret = create(admin, "area", "Intern")
    hidden = create(admin, "page", "Geheim", secret)
    anon = APIClient()
    ids = ",".join([c, "nonsense", hidden, a, "x" * 36, b_])
    got = anon.get(f"/api/public/titles?ids={ids}").json()
    assert [x["title"] for x in got] == ["C", "A", "B"]  # order kept, junk and non-public ids dropped
    admin.delete(f"/api/nodes/{a}")
    assert [x["title"] for x in anon.get(f"/api/public/titles?ids={a},{b_}").json()] == ["B"]
    assert anon.get("/api/public/titles").json() == []
# --- v0.7: Todoist integration (mocked API, no real calls) ------------------------------------------------------

class FakeTodoist:
    """In-memory Todoist: projects, tasks with revision numbers for incremental sync, switchable failures, a call log."""
    TOKEN = "tok-good-0123456789"

    def __init__(self):
        self.projects_ = [{"id": "p-inbox", "name": "Inbox"}, {"id": "p-other", "name": "Privat"}]
        self.items, self.rev, self.calls, self.fail, self.n = {}, 0, [], None, 0

    def client(self, token):
        outer = self

        class C:
            def __init__(self, tok):
                self.tok = tok

            def _enter(self, name, *a):
                outer.calls.append((name, *a))
                if outer.fail:
                    from . import todoist
                    raise todoist.TodoistError(outer.fail)
                if self.tok != outer.TOKEN:
                    from . import todoist
                    raise todoist.TodoistError("auth")

            def projects(self):
                self._enter("projects")
                return [dict(p) for p in outer.projects_]

            def add_project(self, name):
                self._enter("add_project", name)
                p = {"id": f"p-{len(outer.projects_)}", "name": name}
                outer.projects_.append(p)
                return dict(p)

            def sync(self, token):
                self._enter("sync", token)
                since = int(token) if token and token != "*" else 0
                items = [dict(i) for i in outer.items.values() if i["_rev"] > since]
                return {"sync_token": str(outer.rev), "full_sync": since == 0, "items": [x for x in items if not (since == 0 and x.get("checked"))]}

            def add_task(self, project_id, content, description, due):
                self._enter("add_task", content)
                outer.n += 1
                tid = f"t{outer.n}"
                outer.put(tid, project_id=project_id, content=content, description=description, due={"date": due} if due else None)
                return tid

            def update_task(self, task_id, **f):
                self._enter("update_task", task_id)
                i = outer.items[task_id]
                if "content" in f:
                    i["content"] = f["content"]
                if "description" in f:
                    i["description"] = f["description"]
                if "due" in f:
                    i["due"] = {"date": f["due"]} if f["due"] else None
                outer.touch(i)

            def close(self, task_id):
                self._enter("close", task_id)
                outer.items[task_id]["checked"] = True
                outer.touch(outer.items[task_id])

            def reopen(self, task_id):
                self._enter("reopen", task_id)
                outer.items[task_id]["checked"] = False
                outer.touch(outer.items[task_id])

        return C(token)

    def touch(self, item):
        from django.utils import timezone
        self.rev += 1
        item["_rev"] = self.rev
        item["updated_at"] = timezone.now().isoformat()

    def put(self, tid, **fields):
        item = {"id": tid, "checked": False, "is_deleted": False, "due": None, "description": "", **fields}
        self.items[tid] = item
        self.touch(item)
        return item

    def edit(self, tid, **fields):
        """A change made in Todoist itself (not by Findus)."""
        self.items[tid].update(fields)
        self.touch(self.items[tid])

    def project_items(self, name="Findus"):
        pid = next(p["id"] for p in self.projects_ if p["name"] == name)
        return [i for i in self.items.values() if i["project_id"] == pid and not i["is_deleted"]]


@pytest.fixture
def todo(monkeypatch, settings):
    from . import todoist
    fake = FakeTodoist()
    monkeypatch.setattr(todoist, "Client", lambda token: fake.client(token))
    settings.FINDUS_URL = "https://findus.example.org"
    return fake


def _connect(c, token=FakeTodoist.TOKEN, **extra):
    return c.post("/api/integrations/todoist", {"token": token, **extra}, format="json")


def _team_user(admin, name="tina"):
    u, c = _member(name)
    t = _team(admin, f"Team {name}", u)
    return u, c, t


def test_todoist_connect_encrypts_token_and_never_returns_it(admin, todo, db):
    from . import todoist
    from .models import TodoistLink
    u, c, _ = _team_user(admin)
    assert c.get("/api/integrations/todoist").json() == {"allowed": True, "connected": False}
    r = _connect(c, "tok-wrong-0123456789")
    assert r.status_code == 400 and "ungültig" in r.json()["detail"] and not TodoistLink.objects.exists()
    r = _connect(c)
    assert r.status_code == 201 and r.json()["connected"] and r.json()["project"]["name"] == "Findus"
    blob = TodoistLink.objects.get().token_enc
    assert todo.TOKEN not in blob and todoist.decrypt(blob) == todo.TOKEN
    for resp in (r, c.get("/api/integrations/todoist"), c.get("/api/auth/me")):
        assert todo.TOKEN not in resp.content.decode() and "token" not in {k.lower() for k in resp.json()}
    assert [p["name"] for p in todo.projects_].count("Findus") == 1
    assert _connect(c).status_code == 201 and [p["name"] for p in todo.projects_].count("Findus") == 1  # reconnecting reuses the project
    # A key change makes the stored token unreadable: a clear message instead of a crash.
    from cryptography.fernet import Fernet
    from django.test import override_settings
    with override_settings(INTEGRATION_KEY=Fernet.generate_key().decode()):
        assert c.post("/api/integrations/todoist/sync").json()["last_error"].startswith("Der gespeicherte Token ist nicht mehr lesbar")
    assert c.delete("/api/integrations/todoist").json() == {"allowed": True, "connected": False} and not TodoistLink.objects.exists()


def test_todoist_initial_push_own_and_assigned_not_private_not_others(admin, todo, db):
    u, c, _ = _team_user(admin)
    other, oc = _member("otto")
    _team(admin, "Team otto", other)
    own = c.post("/api/tasks", {"title": "Backup prüfen", "due": "2030-05-01", "notes": "Restore testen"}, format="json").json()
    c.post("/api/tasks", {"title": "Geheim", "private": True}, format="json")
    done = c.post("/api/tasks", {"title": "Erledigt"}, format="json").json()
    c.patch(f"/api/tasks/{done['id']}", {"done": True}, format="json")
    oc.post("/api/tasks", {"title": "Von Otto"}, format="json")
    # a colleague gives tina a task: assigned tasks are hers
    mate, mc = _member("mia")
    from .models import TeamMember, Team
    TeamMember.objects.create(team=Team.objects.get(name="Team tina"), user=mate)
    mc.post("/api/tasks", {"title": "Zugewiesen", "user": u.id}, format="json")
    _connect(c)
    titles = sorted(i["content"] for i in todo.project_items())
    assert titles == ["Backup prüfen", "Zugewiesen"]
    item = next(i for i in todo.project_items() if i["content"] == "Backup prüfen")
    assert item["due"] == {"date": "2030-05-01"} and item["description"] == f"Restore testen\n\n🔗 Findus: https://findus.example.org/aufgaben?t={own['id']}"
    assert c.get("/api/tasks").json()[0]["todoist"] is True
    assert c.get(f"/api/tasks/{own['id']}/history").json()[0]["text"] == "Mit Todoist verbunden."
    # private tasks only when the user ticks it
    assert c.patch("/api/integrations/todoist", {"include_private": True}, format="json").json()["include_private"] is True
    c.post("/api/integrations/todoist/sync")
    assert "Geheim" in [i["content"] for i in todo.project_items()]
    # a second run changes nothing
    before = len(todo.calls)
    c.post("/api/integrations/todoist/sync")
    assert not [x for x in todo.calls[before:] if x[0] in ("add_task", "update_task", "close", "reopen")]


def test_todoist_changes_travel_both_ways(admin, todo, db):
    from .models import Task
    u, c, _ = _team_user(admin)
    t = c.post("/api/tasks", {"title": "Drucker", "due": "2030-01-01"}, format="json").json()
    _connect(c)
    tid = todo.project_items()[0]["id"]
    sync = lambda: c.post("/api/integrations/todoist/sync")
    # Findus -> Todoist: title, date, done, reopen, clearing the date
    c.patch(f"/api/tasks/{t['id']}", {"title": "Drucker tauschen", "due": "2030-02-02"}, format="json"); sync()
    assert todo.items[tid]["content"] == "Drucker tauschen" and todo.items[tid]["due"] == {"date": "2030-02-02"}
    c.patch(f"/api/tasks/{t['id']}", {"done": True}, format="json"); sync()
    assert todo.items[tid]["checked"] is True
    c.patch(f"/api/tasks/{t['id']}", {"done": False, "due": None}, format="json"); sync()
    assert todo.items[tid]["checked"] is False and todo.items[tid]["due"] is None
    # Todoist -> Findus
    todo.edit(tid, content="Drucker neu", due={"date": "2031-03-03T10:00:00"}); sync()
    row = Task.objects.get(pk=t["id"])
    assert row.title == "Drucker neu" and str(row.due) == "2031-03-03"
    todo.edit(tid, checked=True); sync()
    assert Task.objects.get(pk=t["id"]).done_at is not None
    todo.edit(tid, checked=False); sync()
    assert Task.objects.get(pk=t["id"]).done_at is None
    assert any("Aus Todoist übernommen" in e["text"] for e in c.get(f"/api/tasks/{t['id']}/history").json())
    # a task created in the Todoist project becomes a Findus task; with the switch off it does not
    new = todo.put("tnew", project_id=next(p["id"] for p in todo.projects_ if p["name"] == "Findus"), content="Aus Todoist", description="Text\n\n🔗 Findus: https://x/y")
    sync()
    imported = Task.objects.get(title="Aus Todoist")
    assert imported.user_id == u.id and imported.notes == "Text"
    c.patch("/api/integrations/todoist", {"import_new": False}, format="json")
    todo.put("tnew2", project_id=new["project_id"], content="Nicht übernehmen"); sync()
    assert not Task.objects.filter(title="Nicht übernehmen").exists()


def test_todoist_conflict_last_change_wins_and_is_noted(admin, todo, db):
    from django.utils import timezone
    from .models import Task
    u, c, _ = _team_user(admin)
    t = c.post("/api/tasks", {"title": "Start"}, format="json").json()
    _connect(c)
    tid = todo.project_items()[0]["id"]
    # Todoist changes later than Findus: Todoist wins
    c.patch(f"/api/tasks/{t['id']}", {"title": "Findus zuerst"}, format="json")
    todo.edit(tid, content="Todoist später")
    c.post("/api/integrations/todoist/sync")
    assert Task.objects.get(pk=t["id"]).title == "Todoist später" and todo.items[tid]["content"] == "Todoist später"
    hist = [e["text"] for e in c.get(f"/api/tasks/{t['id']}/history").json()]
    assert any("Konflikt bei „Titel“" in h and "Todoist" in h for h in hist)
    # Findus changes later than Todoist: Findus wins
    todo.edit(tid, content="Todoist zuerst")
    Task.objects.filter(pk=t["id"]).update(title="Findus später", updated_at=timezone.now() + timezone.timedelta(minutes=5))
    c.post("/api/integrations/todoist/sync")
    assert todo.items[tid]["content"] == "Findus später" and Task.objects.get(pk=t["id"]).title == "Findus später"
    assert any("Konflikt" in e["text"] and "Findus" in e["text"] for e in c.get(f"/api/tasks/{t['id']}/history").json())
    # different fields never conflict: both changes arrive
    c.patch(f"/api/tasks/{t['id']}", {"due": "2032-02-02"}, format="json")
    todo.edit(tid, description="Neue Notiz")
    c.post("/api/integrations/todoist/sync")
    assert todo.items[tid]["due"] == {"date": "2032-02-02"} and Task.objects.get(pk=t["id"]).notes == "Neue Notiz"


def test_todoist_deletions_and_foreign_tasks_are_left_alone(admin, todo, db):
    from .models import Task
    u, c, _ = _team_user(admin)
    keep = c.post("/api/tasks", {"title": "Bleibt"}, format="json").json()
    gone = c.post("/api/tasks", {"title": "Lokal weg"}, format="json").json()
    foreign = todo.put("tf", project_id="p-other", content="Anderes Projekt")
    inbox = todo.put("ti", project_id="p-inbox", content="Eingang")
    _connect(c)
    calls_before = list(todo.calls)
    assert not Task.objects.filter(title__in=["Anderes Projekt", "Eingang"]).exists()  # nothing outside the project comes in
    mine = {i["content"]: i["id"] for i in todo.project_items()}
    # deleted in Todoist: the Findus task stays, unlinked, with a note
    todo.edit(mine["Bleibt"], is_deleted=True)
    c.post("/api/integrations/todoist/sync")
    assert Task.objects.filter(pk=keep["id"]).exists() and c.get("/api/tasks").json()[-1]["todoist"] in (True, False)
    assert any("In Todoist gelöscht" in e["text"] for e in c.get(f"/api/tasks/{keep['id']}/history").json())
    # deleted in Findus: stays in Todoist and is not imported again
    c.delete(f"/api/tasks/{gone['id']}")
    c.post("/api/integrations/todoist/sync"); c.post("/api/integrations/todoist/sync")
    assert todo.items[mine["Lokal weg"]]["is_deleted"] is False and not Task.objects.filter(title="Lokal weg").exists()
    # tasks of other projects were never written
    writes = [x for x in todo.calls if x[0] in ("add_task", "update_task", "close", "reopen") and x[1] in ("tf", "ti")]
    assert not writes and todo.items["tf"]["content"] == "Anderes Projekt" and not todo.items["ti"]["checked"]


def test_todoist_errors_are_shown_and_nothing_is_lost(admin, todo, db):
    from .models import Task, TodoistItem
    u, c, _ = _team_user(admin)
    t = c.post("/api/tasks", {"title": "Eins"}, format="json").json()
    _connect(c)
    n_items = TodoistItem.objects.count()
    todo.fail = "network"
    c.patch(f"/api/tasks/{t['id']}", {"title": "Eins geändert"}, format="json")
    r = c.post("/api/integrations/todoist/sync").json()
    assert "nicht erreichbar" in r["last_error"] and r["last_error_at"]
    assert Task.objects.get(pk=t["id"]).title == "Eins geändert" and TodoistItem.objects.count() == n_items
    todo.fail = "auth"
    assert "ungültig" in c.post("/api/integrations/todoist/sync").json()["last_error"]
    todo.fail = None
    r = c.post("/api/integrations/todoist/sync").json()
    assert r["last_error"] == "" and todo.project_items()[0]["content"] == "Eins geändert"  # the next run delivers it
    # a run that is still going on is not started twice
    from .models import TodoistLink
    from django.utils import timezone
    TodoistLink.objects.update(syncing=True, sync_started_at=timezone.now())
    from . import todoist
    assert todoist.sync_link(TodoistLink.objects.get()) == "busy"


def test_todoist_rights_team_function_global_switch_and_command(admin, todo, db):
    from django.core.management import call_command
    from io import StringIO
    u, c, team = _team_user(admin)
    plain, pc = _plain("paula")
    assert pc.get("/api/integrations/todoist").status_code == 403  # no team: no tasks function
    _connect(c)
    _features(admin, team, tasks=False)  # the team function governs it
    assert c.get("/api/integrations/todoist").status_code == 403 and _connect(c).status_code == 403
    out = StringIO(); call_command("todoist_sync", stdout=out)
    assert "übersprungen" in out.getvalue()
    _features(admin, team, tasks=True)
    out = StringIO(); call_command("todoist_sync", stdout=out)
    assert "tina: ok" in out.getvalue()
    # only admins flip the global switch; off means off for everybody
    assert c.put("/api/admin/integrations", {"todoist_allowed": False}, format="json").status_code == 403
    assert admin.put("/api/admin/integrations", {"todoist_allowed": False}, format="json").status_code == 200
    assert c.get("/api/integrations/todoist").status_code == 403 and c.get("/api/auth/me").json()["todoist"] is False
    out = StringIO(); call_command("todoist_sync", stdout=out)
    assert "ausgeschaltet" in out.getvalue()
    assert admin.get("/api/admin/integrations").json() == {"todoist_allowed": False, "todoist_links": 1}
    admin.put("/api/admin/integrations", {"todoist_allowed": True}, format="json")
    assert c.get("/api/integrations/todoist").json()["connected"] is True
    assert APIClient().get("/api/integrations/todoist").status_code == 403


def test_todoist_choosing_another_project_starts_over_without_touching_tasks(admin, todo, db):
    from .models import Task, TodoistItem
    u, c, _ = _team_user(admin)
    c.post("/api/tasks", {"title": "Eins"}, format="json")
    _connect(c)
    assert [p["name"] for p in c.get("/api/integrations/todoist/projects").json()] == ["Inbox", "Privat", "Findus"]
    r = c.patch("/api/integrations/todoist", {"project_id": "p-other"}, format="json").json()
    assert r["project"] == {"id": "p-other", "name": "Privat"} and not TodoistItem.objects.exists()
    assert c.patch("/api/integrations/todoist", {"project_id": "nope"}, format="json").status_code == 400
    c.post("/api/integrations/todoist/sync")
    assert [i["content"] for i in todo.project_items("Privat")] == ["Eins"] and Task.objects.filter(title="Eins").count() == 1


def test_health_reports_version(client, db):
    r = client.get("/api/health").json()
    assert r["ok"] and r["version"].startswith("0.7")


# --- v0.7 security: login brute-force lock, gate for the document servers --------------------------------------

def test_login_lock_after_failures_progressive_and_audited(db):
    from datetime import timedelta
    from django.contrib.auth import get_user_model
    from django.utils import timezone
    from .models import AuditLog, LoginThrottle
    get_user_model().objects.create_user("lock1", password="right-pw-1")
    get_user_model().objects.create_user("other1", password="right-pw-2")
    c = APIClient()
    login = lambda name, pw: c.post("/api/auth/login", {"username": name, "password": pw}, format="json")
    # Four failures are plain 400s; the fifth locks (still 400 itself), then even the right password gets 429.
    assert [login("lock1", "bad").status_code for _ in range(5)] == [400] * 5
    r = login("lock1", "right-pw-1")
    assert r.status_code == 429 and int(r["Retry-After"]) >= 1 and "Fehlversuche" in r.json()["detail"]
    assert login("LOCK1", "right-pw-1").status_code == 429  # case does not dodge the lock
    assert AuditLog.objects.filter(action="login_failed", username="lock1").count() == 5
    assert AuditLog.objects.filter(action="login_locked", username="lock1").count() == 1  # once per lock, not per blocked request
    # Another account is not affected; its success is not slowed down.
    assert login("other1", "right-pw-2").status_code == 200
    # The lock ends by itself; the next failure doubles it (progressive); a success then clears the counter.
    LoginThrottle.objects.filter(key="user:lock1").update(locked_until=timezone.now() - timedelta(seconds=1))
    assert login("lock1", "bad").status_code == 400
    t = LoginThrottle.objects.get(key="user:lock1")
    assert t.fails == 6 and 50 < (t.locked_until - timezone.now()).total_seconds() <= 60
    LoginThrottle.objects.filter(key="user:lock1").update(locked_until=timezone.now() - timedelta(seconds=1))
    assert login("lock1", "right-pw-1").status_code == 200
    assert not LoginThrottle.objects.filter(key="user:lock1").exists()


def test_login_lock_per_address_and_old_failures_expire(db):
    from datetime import timedelta
    from django.utils import timezone
    from .models import LoginThrottle
    from .throttle import LIMITS
    c = APIClient()
    for i in range(LIMITS["ip"]):  # a different name every time: only the address key can lock
        assert c.post("/api/auth/login", {"username": f"nobody{i}", "password": "x"}, format="json", HTTP_X_FORWARDED_FOR="203.0.113.7").status_code == 400
    r = c.post("/api/auth/login", {"username": "nobody-new", "password": "x"}, format="json", HTTP_X_FORWARDED_FOR="203.0.113.7")
    assert r.status_code == 429
    assert c.post("/api/auth/login", {"username": "nobody-new", "password": "x"}, format="json", HTTP_X_FORWARDED_FOR="203.0.113.8").status_code == 400
    # Failures older than the window start from zero again.
    LoginThrottle.objects.filter(key="user:slow").delete()
    LoginThrottle.objects.create(key="user:slow", fails=4, last_fail=timezone.now() - timedelta(minutes=20))
    assert c.post("/api/auth/login", {"username": "slow", "password": "x"}, format="json").status_code == 400
    assert LoginThrottle.objects.get(key="user:slow").fails == 1 and LoginThrottle.objects.get(key="user:slow").locked_until is None


def test_auth_gate_for_caddy(client, db):
    assert APIClient().get("/api/auth/gate").status_code == 401
    assert client.get("/api/auth/gate").status_code == 204
