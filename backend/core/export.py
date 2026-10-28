"""Export of a page, folder or area: Markdown ZIP with attachments, or PDF rendered by the OnlyOffice ConvertService.

Only nodes the user may read are included (permissions.can), deleted ones never.
"""
import io
import json
import re
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit
import urllib.request

import jwt
from django.conf import settings
from django.core import signing
from django.http import FileResponse, Http404, HttpResponse
from django.utils import timezone
from django.views.decorators.http import require_GET
from markdownify import markdownify
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError

from .files import ONLYOFFICE_INTERNAL, WEB_INTERNAL
from .models import FileVersion, Node
from .permissions import READ, can, can_download

EXPORTABLE = (Node.AREA, Node.FOLDER, Node.PAGE)
DRAWIO_RE = re.compile(r'<div data-drawio="([0-9a-f-]{36})"></div>')
MEDIA_RE = re.compile(r'/media-dl/([0-9a-f-]{36})')
UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
TMP_DIR = "export-tmp"


def safe(name):
    return UNSAFE.sub("_", name).strip(" .")[:100] or "unbenannt"


def collect(user, node, path=()):
    """[(folder path inside the export, node)] for node and its readable, non-deleted descendants in tree order."""
    if node.deleted_at is not None or not can(user, READ, node):
        return []
    out = [(path, node)]
    sub = path + (safe(node.title),) if node.kind in Node.CONTAINERS else path
    for child in node.children.filter(deleted_at=None).order_by("position", "title"):
        out += collect(user, child, sub)
    return out


def page_html(node):
    rev = node.revisions.first()
    return rev.content_html if rev else ""


def readable_version(user, version_id):
    fv = FileVersion.objects.select_related("node").filter(pk=version_id).first()
    return fv if fv and fv.node.deleted_at is None and can(user, READ, fv.node) else None


def readable_file(user, node_id):
    n = Node.objects.filter(pk=node_id, kind=Node.FILE, deleted_at=None).first()
    return n if n and can(user, READ, n) and n.file_versions.exists() else None


def markdown_zip(user, items):
    buf = io.BytesIO()
    media = {}  # zip path per FileVersion id, so each attachment is stored once
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        def add_media(fv):
            if fv.id not in media:
                media[fv.id] = f"_medien/{fv.id.hex[:8]}-{safe(fv.original_name)}"
                z.writestr(media[fv.id], fv.file.open("rb").read())
            return media[fv.id]

        for path, node in items:
            folder = "/".join(path)
            if node.kind == Node.FILE and node.file_versions.exists():
                fv = node.file_versions.first()
                z.writestr(f"{folder}/{safe(fv.original_name)}".lstrip("/"), fv.file.open("rb").read())
            elif node.kind == Node.PAGE:
                up = "../" * len(path)

                def drawio(m):
                    f = readable_file(user, m.group(1))
                    return f'<p><a href="{up}{add_media(f.file_versions.first())}">Schaubild: {f.title}</a></p>' if f else ""

                def image(m):
                    fv = readable_version(user, m.group(1))
                    return up + add_media(fv) if fv else m.group(0)

                html = MEDIA_RE.sub(image, DRAWIO_RE.sub(drawio, page_html(node)))
                body = markdownify(html, heading_style="ATX", bullets="-").strip()
                z.writestr(f"{folder}/{safe(node.title)}.md".lstrip("/"), f"# {node.title}\n\n{body}\n")
    return buf.getvalue()


def export_html(user, items):
    """One HTML document for OnlyOffice; images are fetched by OnlyOffice over the compose network."""
    parts = []
    for i, (path, node) in enumerate(items):
        crumbs = " / ".join(path)
        if node.kind == Node.PAGE:
            def drawio(m):
                f = readable_file(user, m.group(1))
                return f"<p><em>Schaubild „{f.title}“ – in Findus ansehen.</em></p>" if f else ""

            def image(m):
                fv = readable_version(user, m.group(1))
                if not fv:
                    return m.group(0)
                return f"{WEB_INTERNAL}/internal/oo-download/{signing.dumps({'fv': str(fv.id)}, salt='oo-download')}"

            html = MEDIA_RE.sub(image, DRAWIO_RE.sub(drawio, page_html(node)))
            brk = ' style="page-break-before: always"' if i else ""
            parts.append(f"<h1{brk}>{node.title}</h1>" + (f"<p><small>{crumbs}</small></p>" if crumbs else "") + html)
        elif node.kind == Node.FILE:
            parts.append(f"<p>Anhang: {node.title}" + (f" <small>({crumbs})</small>" if crumbs else "") + "</p>")
        elif i == 0:
            parts.append(f"<h1>{node.title}</h1><p><small>Export vom {timezone.localtime():%d.%m.%Y %H:%M}</small></p>")
    style = "body{font-family:Arial,sans-serif;font-size:11pt} img{max-width:100%} table{border-collapse:collapse} td,th{border:1px solid #999;padding:3px}"
    return f'<!doctype html><html><head><meta charset="utf-8"><style>{style}</style></head><body>{"".join(parts)}</body></html>'


def to_pdf(html, title):
    tmp = Path(settings.MEDIA_ROOT) / TMP_DIR
    tmp.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.html"
    (tmp / name).write_text(html, encoding="utf-8")
    try:
        body = {"async": False, "filetype": "html", "outputtype": "pdf", "key": uuid.uuid4().hex, "title": f"{title}.html",
                "url": f"{WEB_INTERNAL}/internal/export-html/{signing.dumps(name, salt='export-html')}"}
        body["token"] = jwt.encode(body, settings.ONLYOFFICE_JWT_SECRET, algorithm="HS256")
        req = urllib.request.Request(f"{ONLYOFFICE_INTERNAL}/ConvertService.ashx", json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            result = json.loads(r.read())
        if not result.get("endConvert") or not result.get("fileUrl"):
            raise ValidationError({"detail": f"PDF-Erzeugung fehlgeschlagen (OnlyOffice-Fehler {result.get('error')})."})
        url = urlsplit(result["fileUrl"])
        # Fetch over the compose network whatever host OnlyOffice put into the URL.
        with urllib.request.urlopen(f"{ONLYOFFICE_INTERNAL}{url.path}" + (f"?{url.query}" if url.query else ""), timeout=120) as r:
            return r.read()
    finally:
        (tmp / name).unlink(missing_ok=True)


def attachment(data, filename, content_type):
    resp = HttpResponse(data, content_type=content_type)
    resp["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
    return resp


@api_view(["GET"])
def export_node(request, node_id):
    node = Node.objects.filter(pk=node_id, deleted_at=None).first()
    if node is None or not can(request.user, READ, node):
        raise NotFound()
    if not can_download(request.user):
        raise PermissionDenied("Export ist für dein Konto nicht freigegeben.")
    if node.kind not in EXPORTABLE:
        raise ValidationError({"detail": "Exportiert werden können Seiten, Ordner und Bereiche."})
    # Not "format": DRF reserves that query parameter for choosing its renderer.
    fmt = request.query_params.get("type", "md")
    items = collect(request.user, node)
    base = safe(node.title)
    if fmt == "md":
        # shortcut: the ZIP is built in memory; stream it if exports of large areas get slow
        return attachment(markdown_zip(request.user, items), f"{base}.zip", "application/zip")
    if fmt == "pdf":
        return attachment(to_pdf(export_html(request.user, items), base), f"{base}.pdf", "application/pdf")
    raise ValidationError({"type": "md oder pdf"})


@require_GET
def export_html_file(request, token):
    """Serves the temporary export HTML to OnlyOffice only (internal path, signed, valid 10 minutes)."""
    try:
        name = signing.loads(token, salt="export-html", max_age=600)
    except signing.BadSignature:
        raise Http404()
    path = Path(settings.MEDIA_ROOT) / TMP_DIR / Path(name).name
    if not path.exists():
        raise Http404()
    return FileResponse(path.open("rb"), content_type="text/html; charset=utf-8")
