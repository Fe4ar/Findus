"""Public help portal API (/hilfe): read-only access to published pages of public areas, nothing else.

Always evaluated as an anonymous visitor, even when a session cookie arrives (same host), so the portal can never show
more than a logged-out visitor may read. No writes, no sessions, no CSRF; throttled per address.
"""
from django.contrib.auth.models import AnonymousUser
from rest_framework.decorators import api_view, throttle_classes
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

from . import search as search_mod
from .models import Node
from .permissions import READ, can
from .stats import count_view, faq_data, ticket_data

ANON = AnonymousUser()


class PublicThrottle(SimpleRateThrottle):
    scope = "public"

    def get_cache_key(self, request, view):
        # shortcut: the cache is per worker process (3 workers), so the effective limit is about 3x; use a shared cache to tighten
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


def _page_or_404(node_id):
    node = Node.objects.filter(pk=node_id, kind=Node.PAGE, deleted_at=None).select_related("parent").first()
    if node is None or not search_mod._visible(ANON, node):
        raise NotFound()
    return node


@api_view(["GET"])
@throttle_classes([PublicThrottle])
def public_faq(request):
    return Response(faq_data(ANON))


@api_view(["GET"])
@throttle_classes([PublicThrottle])
def public_search(request):
    return Response([h for h in search_mod.run(ANON, request.query_params.get("q", ""), faq_only=True) if h["kind"] == "page"])


@api_view(["GET"])
@throttle_classes([PublicThrottle])
def public_page(request, node_id):
    node = _page_or_404(node_id)
    rev = node.revisions.first()
    count_view(node, None)
    return Response({"id": node.id, "title": node.title, "content_html": rev.content_html if rev else "",
                     "updated_at": node.updated_at, "ticket": ticket_data(),
                     # Without the area itself: its name is the portal's business, not a navigation level.
                     "breadcrumb": [{"id": a.id, "title": a.title, "kind": a.kind} for a in node.ancestors()[1:]]})


@api_view(["GET"])
@throttle_classes([PublicThrottle])
def public_titles(request):
    """Titles of the pages a visitor opened before (ids kept in the visitor's own browser); gone or no longer public ones are left out."""
    ids = [i for i in request.query_params.get("ids", "").split(",") if len(i) == 36][:12]
    out = []
    for i in ids:
        try:
            node = _page_or_404(i)
        except (NotFound, ValueError, Exception):
            continue
        out.append({"id": node.id, "title": node.title, "category": node.parent.title if node.parent and node.parent.parent_id else ""})
    return Response(out)
