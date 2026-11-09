"""Network maps (Node kind "map"): live status per element and conversion of the old karte.json format.

Map content (latest PageRevision.content): {"testdaten"?: bool, "hinweis"?: str, "elements": [...]}, element types
rack {x, y, w, name, units}, device/switch {x, y, w, h, name, icon, ip, check, color, ports (switch),
rack?: {id, u, h}}, text {x, y, w, h, text, color}, link {from, to, from_port?, to_port?, label, color}.
"""
import re

from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.response import Response

from .features import enabled
from .models import Node
from .permissions import READ, can
from .services import check_all

CHECK_RE = re.compile(r"^(https?://\S+|tcp://[^\s:/]+:\d{1,5})$")
MAX_CHECKS = 200
DRAWIO_RE = re.compile(r'data-drawio="([0-9a-f-]{36})"')


def element_checks(content):
    """{element id: check URL} for elements with a supported live check."""
    checks = {}
    for e in (content or {}).get("elements", []):
        check = str(e.get("check") or "").strip()
        if e.get("id") and CHECK_RE.match(check):
            checks[str(e["id"])] = check
    return dict(list(checks.items())[:MAX_CHECKS])


@api_view(["GET"])
def map_status(request, node_id):
    node = Node.objects.filter(pk=node_id, kind=Node.MAP, deleted_at=None).first()
    if node is None or not can(request.user, READ, node):
        raise NotFound()
    rev = node.revisions.first()
    checks = element_checks(rev.content if rev else {})
    status = check_all(list(set(checks.values())))
    return Response({eid: status.get(url) for eid, url in checks.items()})


def from_karte_json(data):
    """Converts the old single-map karte.json (rack + devices with uplink) into map content."""
    units = data["rack"]["units"]
    elements = [{"id": "rack", "type": "rack", "x": 20, "y": 20, "w": 320, "name": data["rack"]["name"], "units": units}]
    loose = 0
    for d in data["devices"]:
        kind = "switch" if "switch" in d["name"].lower() else "device"
        e = {"id": d["id"], "type": kind, "name": d["name"], "icon": d.get("icon", ""), "ip": d.get("ip", ""),
             "check": d.get("check", ""), "color": "", "w": 170, "h": 56}
        if kind == "switch":
            e["ports"] = 24
        if d.get("rack"):
            e.update(x=0, y=0, rack={"id": "rack", "u": d["rack"]["u"], "h": d["rack"]["h"]})
        else:
            e.update(x=380 + (loose % 4) * 190, y=20 + (loose // 4) * 80)
            loose += 1
        elements.append(e)
    elements += [{"id": f"link-{d['id']}", "type": "link", "from": d["id"], "to": d["uplink"], "label": d.get("port", ""),
                  "color": ""} for d in data["devices"] if d.get("uplink")]
    return {"testdaten": bool(data.get("testdaten")), "hinweis": data.get("hinweis", ""), "elements": elements}


@api_view(["GET"])
def page_list(request):
    """All wiki pages with their path, for the manual picker in the map editor."""
    if not can(request.user, READ):
        raise NotFound()
    if "network" not in enabled(request.user):
        raise PermissionDenied("Netzwerk ist für dein Team nicht aktiviert.")
    pages = Node.objects.filter(space=Node.WIKI, kind=Node.PAGE, deleted_at=None).select_related("parent")
    out = []
    for p in pages:
        if can(request.user, READ, p) and all(a.deleted_at is None for a in p.ancestors()):
            out.append({"id": p.id, "title": p.title, "path": " / ".join(a.title for a in p.ancestors())})
    return Response(sorted(out, key=lambda p: (p["path"], p["title"])))


@api_view(["GET"])
def page_maps(request, node_id):
    """Backlinks: maps with elements whose "page" points at this node."""
    node = Node.objects.filter(pk=node_id, deleted_at=None).first()
    if node is None or not can(request.user, READ, node):
        raise NotFound()
    out = []
    # shortcut: scans the latest revision of every map; fine for dozens of maps, index the links if it grows
    for m in Node.objects.filter(space=Node.KARTE, kind=Node.MAP, deleted_at=None):
        rev = m.revisions.first()
        hits = [{"id": e.get("id"), "name": e.get("name") or e.get("type")}
                for e in (rev.content if rev else {}).get("elements", []) if str(e.get("page") or "") == str(node.id)]
        if hits and can(request.user, READ, m):
            out.append({"id": m.id, "kind": m.kind, "title": m.title, "elements": hits})
    # Shortcuts in the network tree to this node or to a diagram embedded in this page.
    targets = {node.id}
    rev = node.revisions.first() if node.kind == Node.PAGE else None
    if rev:
        targets |= set(DRAWIO_RE.findall(rev.content_html))
    for link in Node.objects.filter(kind=Node.LINK, deleted_at=None, target_id__in=targets).order_by("title"):
        if can(request.user, READ, link):
            out.append({"id": link.id, "kind": link.kind, "title": link.title, "elements": []})
    return Response(out)
