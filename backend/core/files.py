"""File upload/download and the OnlyOffice integration."""
import hashlib
import json
import mimetypes
import os
import urllib.request
from urllib.parse import urlsplit

import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.files.base import ContentFile, File
from django.db import transaction
from django.http import FileResponse, Http404, JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.response import Response

from .models import FileVersion, Node
from . import audit
from .permissions import PUBLISH, READ, WRITE, can, can_download
from .search import version_text
from .views import node_detail, node_or_404, user_name

ONLYOFFICE_INTERNAL = "http://onlyoffice"
# Caddy serves OnlyOffice under this path of every Findus host, so it works behind NPM without a port of its own.
OFFICE_PREFIX = "/office"
# How OnlyOffice reaches this app; a parallel test stack points it at its own web container.
WEB_INTERNAL = os.environ.get("WEB_INTERNAL", "http://web:8000")
DOC_TYPES = {
    "word": {"docx", "doc", "odt", "rtf"},
    "cell": {"xlsx", "xls", "ods"},
    "slide": {"pptx", "ppt", "odp"},
}
# Browsers render these inline; anything else (html, svg, xml, …) is forced to download to avoid script execution.
INLINE_TYPES = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"}
# python:slim ships no /etc/mime.types, so Office types would otherwise come out as octet-stream.
for _ext, _mime in {
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
    ".md": "text/markdown", ".webp": "image/webp",
}.items():
    mimetypes.add_type(_mime, _ext)
TEXT_EXT = {".md", ".txt", ".log", ".csv", ".json", ".yaml", ".yml", ".conf", ".ini", ".sh", ".py"}


def _guess_mime(name, fallback):
    return mimetypes.guess_type(name)[0] or fallback or "application/octet-stream"


def _save_version(node, fileobj, name, user, comment="", source=FileVersion.UPLOAD):
    digest, size = hashlib.sha256(), 0
    for chunk in fileobj.chunks():
        digest.update(chunk)
        size += len(chunk)
    fileobj.seek(0)
    fv = FileVersion(node=node, original_name=name[:255], size=size, sha256=digest.hexdigest(), user=user,
                     comment=comment[:255], source=source,
                     mime=_guess_mime(name, getattr(fileobj, "content_type", None)))
    # Identical content (same hash and size) is stored once: the new version points at the file that already exists.
    same = FileVersion.objects.filter(sha256=fv.sha256, size=size).exclude(file="").first()
    if same and fv.file.storage.exists(same.file.name):
        fv.file.name = same.file.name
    else:
        fv.file.save(fv.id.hex, fileobj, save=False)
    fv.save()
    node.search_text = version_text(fv)
    node.version += 1
    node.updated_by = user
    node.save()
    return fv


def _uploaded(request):
    f = request.FILES.get("file")
    if f is None:
        raise ValidationError({"file": "Keine Datei übermittelt."})
    if f.size > settings.MAX_UPLOAD_MB * 1024 * 1024:
        raise ValidationError({"file": f"Datei ist größer als {settings.MAX_UPLOAD_MB} MB."})
    return f


@api_view(["POST"])
def file_upload(request):
    parent = node_or_404(request.user, request.data.get("parent"), WRITE)
    if parent.kind not in Node.CONTAINERS or parent.space != Node.WIKI:
        raise ValidationError({"parent": "Ziel muss ein Bereich oder Ordner sein."})
    f = _uploaded(request)
    name = os.path.basename(f.name)
    attachment = str(request.data.get("attachment") or "") in ("1", "true")  # pasted image / embedded document of a page
    with transaction.atomic():
        last = Node.objects.filter(parent=parent, deleted_at=None).order_by("-position").first()
        node = Node.objects.create(parent=parent, kind=Node.FILE, title=name[:255], hidden=attachment,
                                   position=(last.position + 1) if last else 0,
                                   status=Node.PUBLISHED if can(request.user, PUBLISH, parent) else Node.DRAFT,
                                   created_by=request.user, updated_by=request.user)
        _save_version(node, f, name, request.user, request.data.get("comment", ""))
    audit.log(request, "create", node, kind=Node.FILE, file=name)
    return Response(node_detail(request.user, node), status=201)


def _file_node(user, node_id, action):
    node = node_or_404(user, node_id, action)
    if node.kind != Node.FILE:
        raise NotFound()
    return node


@api_view(["POST"])
def file_new_version(request, node_id):
    node = _file_node(request.user, node_id, WRITE)
    f = _uploaded(request)
    with transaction.atomic():
        _save_version(node, f, os.path.basename(f.name), request.user, request.data.get("comment", ""))
    audit.log(request, "update", node, file=os.path.basename(f.name))
    return Response(node_detail(request.user, node))


@api_view(["POST"])
def file_restore(request, node_id, version_id):
    node = _file_node(request.user, node_id, WRITE)
    old = get_object_or_404(node.file_versions, pk=version_id)
    with transaction.atomic(), old.file.open("rb") as fh:
        _save_version(node, File(fh, name=old.original_name), old.original_name, request.user,
                      f"Wiederhergestellt: {old.original_name}", FileVersion.RESTORE)
    audit.log(request, "restore", node, file=old.original_name)
    return Response(node_detail(request.user, node))


def _file_response(fv, download):
    inline = not download and fv.mime in INLINE_TYPES
    mime = fv.mime
    if not download and os.path.splitext(fv.original_name.lower())[1] in TEXT_EXT:
        mime, inline = "text/plain; charset=utf-8", True
    resp = FileResponse(fv.file.open("rb"), as_attachment=not inline, filename=fv.original_name, content_type=mime)
    resp["X-Content-Type-Options"] = "nosniff"
    # The page shows PDFs (and embedded documents) in an iframe of its own origin; Django's default DENY would make the
    # browser refuse that frame ("… hat die Verbindung abgelehnt"). SAMEORIGIN still keeps other sites from framing files.
    resp["X-Frame-Options"] = "SAMEORIGIN"
    if mime.startswith("text/"):
        resp["Content-Security-Policy"] = "sandbox"
    return resp


@require_GET
def media_download(request, version_id):
    fv = get_object_or_404(FileVersion.objects.select_related("node"), pk=version_id)
    node = fv.node
    if any(n.deleted_at for n in [node, *node.ancestors()]) or not can(request.user, READ, node):
        raise Http404()
    download = request.GET.get("download") == "1"
    if download and not can_download(request.user):
        return JsonResponse({"detail": "Herunterladen ist für dein Konto nicht freigegeben."}, status=403)
    return _file_response(fv, download)


# --- OnlyOffice -----------------------------------------------------------------------------------------------

def _doc_type(name):
    ext = os.path.splitext(name.lower())[1].lstrip(".")
    for doc_type, exts in DOC_TYPES.items():
        if ext in exts:
            return doc_type, ext
    return None, ext


@api_view(["GET"])
def onlyoffice_config(request, node_id):
    mode = request.query_params.get("mode", "view")
    node = _file_node(request.user, node_id, WRITE if mode == "edit" else READ)
    fv = node.file_versions.first()
    doc_type, ext = _doc_type(fv.original_name) if fv else (None, None)
    if doc_type is None:
        raise ValidationError({"detail": "Dieser Dateityp wird von OnlyOffice nicht unterstützt."})
    download_token = signing.dumps({"fv": str(fv.id)}, salt="oo-download")
    config = {
        "document": {
            "fileType": ext,
            # A new version gets a new id, so OnlyOffice never serves a stale cached copy.
            "key": fv.id.hex,
            "title": fv.original_name,
            "url": f"{WEB_INTERNAL}/internal/oo-download/{download_token}",
            "permissions": {"edit": mode == "edit", "download": can_download(request.user), "print": can_download(request.user)},
        },
        "documentType": doc_type,
        "editorConfig": {
            "mode": mode,
            "lang": "de",
            "user": {"id": str(request.user.pk), "name": user_name(request.user)},
            "customization": {"forcesave": False, "compactHeader": True},
        },
        "height": "100%",
        "width": "100%",
    }
    if mode == "edit":
        cb_token = signing.dumps({"node": str(node.id), "user": request.user.pk}, salt="oo-callback")
        config["editorConfig"]["callbackUrl"] = f"{WEB_INTERNAL}/internal/oo-callback/{cb_token}"
    config["token"] = jwt.encode(config, settings.ONLYOFFICE_JWT_SECRET, algorithm="HS256")
    return Response({"config": config, "api_js": f"{OFFICE_PREFIX}/web-apps/apps/api/documents/api.js"})


@require_GET
def oo_download(request, token):
    try:
        data = signing.loads(token, salt="oo-download", max_age=3600)
    except signing.BadSignature:
        raise Http404()
    fv = get_object_or_404(FileVersion, pk=data["fv"])
    return FileResponse(fv.file.open("rb"), content_type=fv.mime)


@csrf_exempt
@require_POST
def oo_callback(request, token):
    try:
        cb = signing.loads(token, salt="oo-callback", max_age=7 * 24 * 3600)
        body = json.loads(request.body or b"{}")
        payload = jwt.decode(body.get("token", ""), settings.ONLYOFFICE_JWT_SECRET, algorithms=["HS256"])
    except (signing.BadSignature, ValueError, jwt.PyJWTError):
        return JsonResponse({"error": 1, "message": "forbidden"}, status=403)

    if payload.get("status") in (2, 6):
        url = urlsplit(payload.get("url", ""))
        if url.netloc not in {"onlyoffice", *settings.WIKI_HOSTS}:
            return JsonResponse({"error": 1, "message": "bad url host"}, status=400)
        # Always fetch over the compose network, whatever public host OnlyOffice put into the URL.
        path = url.path[len(OFFICE_PREFIX):] if url.path.startswith(OFFICE_PREFIX + "/") else url.path
        internal = f"{ONLYOFFICE_INTERNAL}{path}" + (f"?{url.query}" if url.query else "")
        with urllib.request.urlopen(internal, timeout=60) as r:
            content = r.read()
        node = get_object_or_404(Node, pk=cb["node"], kind=Node.FILE)
        users = payload.get("users") or [cb["user"]]
        editor = get_user_model().objects.filter(pk=users[0]).first() or get_user_model().objects.filter(pk=cb["user"]).first()
        name = node.file_versions.first().original_name
        with transaction.atomic():
            _save_version(node, ContentFile(content, name=name), name, editor, "Bearbeitet in OnlyOffice",
                          FileVersion.ONLYOFFICE)
        audit.log(None, "update", node, user=editor, source="onlyoffice")
    return JsonResponse({"error": 0})
