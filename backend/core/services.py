"""Service dashboard: links from services.json plus a server-side reachability check (shared with the map)."""
import json
import socket
import ssl
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from django.conf import settings
from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound
from rest_framework.response import Response


# services.json is instance data (not in git); without it the dashboard shows the example list.
SERVICES_FILE = settings.BASE_DIR / "services.json"
if not SERVICES_FILE.exists():
    SERVICES_FILE = settings.BASE_DIR / "services.example.json"
CACHE_SECONDS = 60
# Internal services mostly use self-signed certs; we only check reachability, never send credentials.
_NO_VERIFY = ssl.create_default_context()
_NO_VERIFY.check_hostname = False
_NO_VERIFY.verify_mode = ssl.CERT_NONE
_cache = {}  # url -> (checked_at, up)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # a redirect already proves the service answers (the printer redirects to a dead HTTPS port)


_opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=_NO_VERIFY))


def is_up(url):
    if url.startswith("tcp://"):  # devices without a web UI: an open TCP port counts as up
        host, port = url[6:].rsplit(":", 1)
        try:
            socket.create_connection((host, int(port)), timeout=3).close()
            return True
        except OSError:
            return False
    try:
        _opener.open(url, timeout=3).close()
        return True
    except urllib.error.HTTPError:
        return True  # 401/403/404 still means the service answers
    except Exception:
        return False


def check_all(urls):
    now = time.monotonic()
    stale = [u for u in set(urls) if now - _cache.get(u, (-CACHE_SECONDS - 1, None))[0] > CACHE_SECONDS]
    if stale:
        with ThreadPoolExecutor(max_workers=16) as pool:
            _cache.update({u: (now, up) for u, up in zip(stale, pool.map(is_up, stale))})
    return {u: _cache[u][1] for u in urls}


@api_view(["GET"])
def services(request):
    if not request.user.is_authenticated:
        raise NotFound()
    items = json.loads(SERVICES_FILE.read_text(encoding="utf-8"))
    status = check_all([s["url"] for s in items])
    return Response([{**s, "online": status.get(s["url"])} for s in items])
