"""Audit log: who did what to which node, from where."""
import ipaddress

from .models import AuditLog


def client_ip(request):
    # web is reachable only through Caddy, which sets X-Forwarded-For (keeping the entry of a reverse proxy in front).
    raw = (request.META.get("HTTP_X_FORWARDED_FOR") or "").split(",")[0].strip() or request.META.get("REMOTE_ADDR", "")
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return None


def log(request, action, node=None, user=None, username="", **details):
    """request may be None for internal callbacks (OnlyOffice); user defaults to the request's user."""
    if user is None and request is not None and request.user.is_authenticated:
        user = request.user
    AuditLog.objects.create(user=user, username=username or (user.get_username() if user else ""), action=action,
                            node=node, node_title=node.title if node else "", details=details,
                            ip=client_ip(request) if request is not None else None)
