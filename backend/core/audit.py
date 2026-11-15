"""Audit log: who did what to which node, from where."""
import ipaddress

from .models import AuditLog


def client_ip(request):
    # web is reachable only through Caddy (no published port of its own); Caddy resolves the real client IP (trusted_proxies in
    # the Caddyfile keeps a trusted reverse proxy's entry, ignores a client's own X-Forwarded-For otherwise) and sends it as
    # X-Real-IP, which nothing else can set. A raw X-Forwarded-For is never trusted: it can carry a client-supplied first value
    # (classic bypass of IP-based throttling), and nothing with internal access speaks to the app except through this Caddy.
    raw = request.META.get("HTTP_X_REAL_IP") or request.META.get("REMOTE_ADDR", "")
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return None


def team_of(node):
    from .models import Team
    root = node
    while root.parent_id:
        root = root.parent
    return Team.objects.filter(area_id=root.pk).first()


def log(request, action, node=None, user=None, username="", team=None, **details):
    """request may be None for internal callbacks (OnlyOffice); user defaults to the request's user."""
    if user is None and request is not None and request.user.is_authenticated:
        user = request.user
    AuditLog.objects.create(user=user, username=username or (user.get_username() if user else ""), action=action,
                            node=node, team=team or (team_of(node) if node else None), node_title=node.title if node else "", details=details,
                            ip=client_ip(request) if request is not None else None)
