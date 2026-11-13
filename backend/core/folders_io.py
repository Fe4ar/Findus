"""Import a local folder into a Findus folder (one file per request) and export a folder as ZIP of the original files."""
import os
import re
import tempfile
import zipfile
from datetime import timedelta

from django.conf import settings
from django.db import transaction
from django.http import FileResponse, JsonResponse
from django.utils import timezone
from rest_framework.decorators import api_view
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from . import audit
from .export import collect, safe
from .files import _save_version, _uploaded
from .models import FileVersion, Node
from .permissions import PUBLISH, WRITE, can, can_download
from .views import node_or_404

MAX_DEPTH = 12
BAD_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def clean_part(name):
    name = BAD_CHARS.sub("_", name).strip(" .")
    return name[:200] or "_"


def clean_path(raw):
    """Folder names and file name from a browser path like 'Doku/Netz/plan.docx'; refuses absolute paths and '..'."""
    raw = str(raw or "").replace("\\", "/")
    if raw.startswith("/") or "\x00" in raw:
        raise ValidationError({"path": "Ungültiger Pfad."})
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts) or len(parts) > MAX_DEPTH + 1:
        raise ValidationError({"path": "Ungültiger Pfad."})
    return [clean_part(p) for p in parts[:-1]], clean_part(parts[-1])


def _child(parent, kind, title, user, publish):
    node = Node.objects.filter(parent=parent, kind=kind, title=title, deleted_at=None).first()
    if node:
        return node, False
    last = Node.objects.filter(parent=parent, deleted_at=None).order_by("-position").first()
    node = Node.objects.create(parent=parent, kind=kind, title=title, position=(last.position + 1) if last else 0,
                               status=Node.PUBLISHED if publish else Node.DRAFT, created_by=user, updated_by=user)
    return node, True


@api_view(["POST"])
def import_file(request):
    """One file of a folder import: creates the missing folders below `parent`, then the file (or a new version of it)."""
    parent = node_or_404(request.user, request.data.get("parent"), WRITE)
    if parent.kind not in Node.CONTAINERS or parent.space != Node.WIKI:
        raise ValidationError({"parent": "Ziel muss ein Bereich oder Ordner sein."})
    folders, name = clean_path(request.data.get("path"))
    f = _uploaded(request)
    since = timezone.now() - timedelta(hours=1)
    if FileVersion.objects.filter(user=request.user, comment__startswith="Import", created_at__gte=since).count() >= settings.IMPORT_MAX_FILES_PER_HOUR:
        raise ValidationError({"detail": "Zu viele importierte Dateien in der letzten Stunde."})
    publish = can(request.user, PUBLISH, parent)
    with transaction.atomic():
        node = parent
        for part in folders:
            node, _ = _child(node, Node.FOLDER, part, request.user, publish)
        file_node, created = _child(node, Node.FILE, name, request.user, publish)
        _save_version(file_node, f, name, request.user, "Import")
    audit.log(request, "create" if created else "update", file_node, kind=Node.FILE, file=name, source="import")
    return Response({"id": str(file_node.id), "created": created}, status=201 if created else 200)


MAX_PDF_PAGES = 60  # each page is a conversion round trip to OnlyOffice; beyond this the pages are exported as HTML


@api_view(["GET"])
def export_originals(request, node_id):
    """ZIP with the newest original of every readable file below a folder or area and every readable page as PDF, structure kept."""
    node = node_or_404(request.user, node_id)
    if node.kind not in Node.CONTAINERS:
        raise ValidationError({"detail": "Nur Bereiche und Ordner lassen sich exportieren."})
    if not can_download(request.user):
        return JsonResponse({"detail": "Exportieren ist für dein Konto nicht freigegeben."}, status=403)
    from .export import export_html, to_pdf
    tmp = tempfile.TemporaryFile()
    used = set()

    def unique(arc):
        base, i = arc, 1
        while arc.lower() in used:  # same name twice in one folder
            root, ext = os.path.splitext(base)
            arc, i = f"{root} ({i}){ext}", i + 1
        used.add(arc.lower())
        return arc

    pdf_pages = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for path, n in collect(request.user, node):
            if n.kind == Node.PAGE and not n.hidden:
                # Pages come along as PDF (one per page, in their folder); more than MAX_PDF_PAGES or a failing converter: plain HTML instead.
                html = export_html(request.user, [(path, n)])
                data, ext = None, ".pdf"
                if pdf_pages < MAX_PDF_PAGES:
                    try:
                        data = to_pdf(html, safe(n.title))
                        pdf_pages += 1
                    except Exception:  # OnlyOffice down or the page cannot be converted: keep the content as HTML
                        data = None
                if data is None:
                    data, ext = html.encode("utf-8"), ".html"
                z.writestr(unique("/".join((*path, safe(n.title) + ext))), data)
                continue
            fv = n.file_versions.first() if n.kind == Node.FILE else None
            if fv is None:
                continue
            arc = unique("/".join((*path, safe(fv.original_name))))
            with fv.file.open("rb") as src, z.open(arc, "w") as dst:
                for chunk in iter(lambda: src.read(1024 * 1024), b""):
                    dst.write(chunk)
    tmp.seek(0)
    audit.log(request, "update", node, source="export-originals")
    return FileResponse(tmp, as_attachment=True, filename=f"{safe(node.title)}.zip", content_type="application/zip")
