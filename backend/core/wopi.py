"""Collabora Online as WOPI client: Findus is the WOPI host (CheckFileInfo, GetFile, PutFile, locks).

The browser gets a short-lived access_token that is signed per file and user. Rights are checked again on every call,
so a revoked right takes effect at the next request. Every save from Collabora becomes a new file version.
"""
import os
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import timedelta
from urllib.parse import quote, urlsplit

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core import signing
from django.core.files.base import ContentFile
from django.db import transaction
from django.http import FileResponse, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.response import Response

from . import audit
from .files import _file_node, _save_version
from .models import FileVersion, Node, WopiLock
from .permissions import READ, WRITE, can, can_download
from .views import user_name

TOKEN_TTL = 4 * 3600
LOCK_TTL = timedelta(minutes=30)
EXTENSIONS = {"docx", "xlsx", "pptx", "odt", "ods", "odp", "doc", "xls", "ppt", "rtf"}
_discovery = {"at": 0.0, "actions": {}}


def is_office(name):
    return os.path.splitext(name.lower())[1].lstrip(".") in EXTENSIONS


def _actions():
    """{(action, ext): urlsrc path} from Collabora's discovery, cached for ten minutes."""
    if time.time() - _discovery["at"] > 600 or not _discovery["actions"]:
        url = f"http://{settings.COLLABORA_UPSTREAM}/collabora/hosting/discovery"
        with urllib.request.urlopen(url, timeout=10) as r:
            root = ET.fromstring(r.read())
        _discovery["actions"] = {(a.get("name"), a.get("ext")): urlsplit(a.get("urlsrc")).path
                                 for a in root.iter("action") if a.get("urlsrc") and a.get("ext")}
        _discovery["at"] = time.time()
    return _discovery["actions"]


def make_token(user, node, mode):
    return signing.dumps({"u": user.pk, "n": str(node.id), "m": mode}, salt="wopi")


def _authorize(request, node_id):
    """(node, user, mode) for a valid token on this file, else None. Rights are re-evaluated here, not trusted from the token."""
    token = request.GET.get("access_token") or request.headers.get("Authorization", "").removeprefix("Bearer ")
    try:
        d = signing.loads(token, salt="wopi", max_age=TOKEN_TTL)
    except signing.BadSignature:
        return None
    if d["n"] != str(node_id):
        return None
    user = get_user_model().objects.filter(pk=d["u"], is_active=True).first()
    node = Node.objects.filter(pk=node_id, kind=Node.FILE, deleted_at=None).first()
    if not user or not node or any(n.deleted_at for n in node.ancestors()) or not can(user, READ, node):
        return None
    return node, user, d["m"]


@api_view(["GET"])
def collabora_config(request, node_id):
    """URL and token the browser posts into the Collabora iframe."""
    if not settings.COLLABORA_UPSTREAM:
        raise NotFound()
    mode = "edit" if request.query_params.get("mode") == "edit" else "view"
    node = _file_node(request.user, node_id, WRITE if mode == "edit" else READ)
    fv = node.file_versions.first()
    ext = os.path.splitext(fv.original_name.lower())[1].lstrip(".") if fv else ""
    if ext not in EXTENSIONS:
        raise ValidationError({"detail": "Dieser Dateityp wird von Collabora nicht unterstützt."})
    try:
        actions = _actions()
    except OSError:
        raise ValidationError({"detail": "Collabora ist nicht erreichbar."})
    path = actions.get(("edit" if mode == "edit" else "view", ext)) or actions.get(("edit", ext))
    if not path:
        raise ValidationError({"detail": "Collabora kennt diesen Dateityp nicht."})
    host = request.get_host()
    wopi_src = f"https://{host}/wopi/files/{node.id}"
    return Response({"url": f"https://{host}{path}?WOPISrc={quote(wopi_src, safe='')}&lang=de",
                     "token": make_token(request.user, node, mode), "ttl": int((time.time() + TOKEN_TTL) * 1000)})


def _deny():
    return HttpResponse(status=401)


def _version_headers(node, **extra):
    fv = node.file_versions.first()
    return {"X-WOPI-ItemVersion": str(fv.id) if fv else "", **extra}


def _active_lock(node):
    lock = WopiLock.objects.filter(node=node).first()
    if lock and lock.expires <= timezone.now():
        lock.delete()
        return None
    return lock


def _conflict(node):
    lock = _active_lock(node)
    return HttpResponse(status=409, headers={"X-WOPI-Lock": lock.lock if lock else ""})


@csrf_exempt
def check_file_info_or_lock(request, node_id):
    auth = _authorize(request, node_id)
    if auth is None:
        return _deny()
    node, user, mode = auth
    if request.method == "GET":
        fv = node.file_versions.first()
        write = mode == "edit" and can(user, WRITE, node)
        export = can_download(user)
        return JsonResponse({
            "BaseFileName": fv.original_name, "Size": fv.size, "SHA256": fv.sha256, "Version": str(fv.id),
            "OwnerId": str(node.created_by_id or 0), "UserId": str(user.pk), "UserFriendlyName": user_name(user),
            "LastModifiedTime": fv.created_at.isoformat(),
            "UserCanWrite": write, "UserCanNotWriteRelative": True, "SupportsUpdate": True,
            "SupportsLocks": True, "SupportsGetLock": True,
            # Without export right: no print, no download/export, no save-as; the document can still be read.
            "DisablePrint": not export, "DisableExport": not export, "DisableCopy": False,
            "HidePrintOption": not export, "HideExportOption": not export, "HideSaveOption": not export,
        })
    if request.method != "POST":
        return HttpResponse(status=405)
    op = request.headers.get("X-WOPI-Override", "")
    if op not in {"LOCK", "UNLOCK", "REFRESH_LOCK", "GET_LOCK"}:
        return HttpResponse(status=501)  # PUT_RELATIVE, RENAME_FILE, ... are not offered
    if op == "GET_LOCK":
        lock = _active_lock(node)
        return HttpResponse(status=200, headers={"X-WOPI-Lock": lock.lock if lock else ""})
    if mode != "edit" or not can(user, WRITE, node):
        return HttpResponse(status=401)
    wanted, old = request.headers.get("X-WOPI-Lock", ""), request.headers.get("X-WOPI-OldLock")
    with transaction.atomic():
        node = Node.objects.select_for_update().get(pk=node.pk)
        cur = _active_lock(node)
        if op == "LOCK":
            if cur and cur.lock != (old if old is not None else wanted):
                return _conflict(node)
            WopiLock.objects.update_or_create(node=node, defaults={"lock": wanted, "expires": timezone.now() + LOCK_TTL})
        elif not cur or cur.lock != wanted:
            return _conflict(node)
        elif op == "REFRESH_LOCK":
            cur.expires = timezone.now() + LOCK_TTL
            cur.save()
        else:  # UNLOCK
            cur.delete()
    return HttpResponse(status=200, headers=_version_headers(node))


@csrf_exempt
def contents(request, node_id):
    auth = _authorize(request, node_id)
    if auth is None:
        return _deny()
    node, user, mode = auth
    fv = node.file_versions.first()
    if request.method == "GET":
        resp = FileResponse(fv.file.open("rb"), content_type="application/octet-stream")
        resp["X-WOPI-ItemVersion"] = str(fv.id)
        return resp
    if request.method != "POST":
        return HttpResponse(status=405)
    if mode != "edit" or not can(user, WRITE, node):
        return HttpResponse(status=401)
    if len(request.body) > settings.MAX_UPLOAD_MB * 1024 * 1024:
        return HttpResponse(status=413)
    # shortcut: a save without any lock is accepted (Collabora always locks first); a different lock is a conflict.
    cur = _active_lock(node)
    if cur and cur.lock != request.headers.get("X-WOPI-Lock", ""):
        return _conflict(node)
    with transaction.atomic():
        new = _save_version(node, ContentFile(request.body, name=fv.original_name), fv.original_name, user,
                            "Bearbeitet in Collabora", FileVersion.COLLABORA)
    audit.log(None, "update", node, user=user, source="collabora")
    return HttpResponse(status=200, headers={"X-WOPI-ItemVersion": str(new.id)})
