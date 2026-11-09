"""Full-text search over page content and uploaded files (Postgres tsvector, German config).

Node.search_text holds the extracted plain text; a database trigger (migration 0002) builds
Node.search_vector from title (weight A) and search_text (weight B).
"""
import html
import io
import os
import re
import zipfile

import nh3
from django.contrib.postgres.search import SearchHeadline, SearchQuery, SearchRank
from django.db.models import F
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Node
from .permissions import is_public, READ, can

# A tsvector may not exceed 1 MB; plain text of that length is far beyond any useful document.
MAX_CHARS = 200_000
# Marks the hits in snippets; the frontend turns them into <mark> without parsing HTML.
HIT_START, HIT_STOP = "\x02", "\x03"
TEXT_EXT = {".md", ".txt", ".log", ".csv", ".json", ".yaml", ".yml", ".conf", ".ini", ".sh", ".py"}
# Office Open XML and OpenDocument are zip files of XML parts; these parts hold the visible text.
ZIP_PARTS = {
    ".docx": re.compile(r"word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml"),
    ".xlsx": re.compile(r"xl/(sharedStrings|worksheets/sheet\d+)\.xml"),
    ".pptx": re.compile(r"ppt/(slides/slide\d+|notesSlides/notesSlide\d+)\.xml"),
    ".odt": re.compile(r"content\.xml"), ".ods": re.compile(r"content\.xml"), ".odp": re.compile(r"content\.xml"),
}
_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def _clean(text):
    return _SPACE.sub(" ", text).strip()[:MAX_CHARS]


def _xml_text(xml):
    # Tags become spaces so adjacent cells and paragraphs do not run together.
    return html.unescape(_TAG.sub(" ", xml))


def html_text(content_html):
    return _clean(html.unescape(nh3.clean(content_html.replace("<", " <"), tags=set())))


def revision_text(kind, content, content_html):
    """Searchable text of a page or map revision; maps contribute element names, IPs and labels."""
    if kind == "map":
        elements = (content or {}).get("elements") or []
        return _clean(" ".join(str(e.get(k) or "") for e in elements if isinstance(e, dict)
                               for k in ("name", "ip", "label", "text")))
    return html_text(content_html)


def file_text(name, fh):
    """Plain text of an uploaded file, or "" for types without extractable text."""
    ext = os.path.splitext(name.lower())[1]
    if name.lower().endswith(".drawio"):
        ext = ".drawio"
    try:
        data = fh.read()
        if ext in TEXT_EXT:
            return _clean(data.decode("utf-8", "replace"))
        if ext == ".drawio":
            # Shape labels live in value="…" (may themselves contain HTML).
            labels = re.findall(r'\bvalue="([^"]*)"', data.decode("utf-8", "replace"))
            return _clean(" ".join(_xml_text(html.unescape(v)) for v in labels))
        if ext in ZIP_PARTS:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                parts = sorted(n for n in z.namelist() if ZIP_PARTS[ext].fullmatch(n))
                return _clean(" ".join(_xml_text(z.read(n).decode("utf-8", "replace")) for n in parts))
        if ext == ".pdf":
            from pypdf import PdfReader
            return _clean(" ".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages))
    except Exception:
        # A broken or encrypted file must never block the upload; it is only not searchable.
        return ""
    return ""


def version_text(fv):
    with fv.file.open("rb") as fh:
        return file_text(fv.original_name, fh)


def to_query(q):
    """Prefix match on every word, all words required. Tokens are restricted, so no tsquery syntax gets through."""
    words = [w.strip(".-") for w in re.findall(r"[\w.-]+", q)]
    words = [w for w in words if w][:10]
    if not words:
        return None
    return SearchQuery(" & ".join(f"'{w}':*" for w in words), config="german", search_type="raw")


def _visible(user, node):
    return all(n.deleted_at is None for n in node.ancestors()) and can(user, READ, node)


SCOPE_TEAM = re.compile(r"team:(\d+)")
_EXACT_TOKEN = re.compile(r'"([^"]+)"|(\S+)')


def exact_patterns(text):
    """Exact mode: "quoted words" are one phrase, every other word stands alone; whole words only, no stems, no prefixes."""
    pats = []
    for phrase, word in _EXACT_TOKEN.findall(text)[:10]:
        parts = re.findall(r"[\w.-]+", phrase or word)
        parts = [w.strip(".-") for w in parts if w.strip(".-")]
        if parts:
            pats.append(re.compile(r"(?<!\w)" + r"\s+".join(re.escape(w) for w in parts) + r"(?!\w)", re.IGNORECASE))
    return pats


def exact_snippet(text, pats):
    """Up to two fragments around the first exact hits, hits marked like ts_headline does."""
    spans = sorted((m.start(), m.end()) for p in pats for m in p.finditer(text or ""))
    frags, upto = [], -1
    for start, end in spans:
        if start < upto:
            continue
        frags.append((max(0, start - 60), min(len(text), end + 90)))
        upto = frags[-1][1]
        if len(frags) == 2:
            break
    if not frags:
        return ""
    both = re.compile("|".join(f"(?:{p.pattern})" for p in pats), re.IGNORECASE)
    return " … ".join(both.sub(lambda m: HIT_START + m.group(0) + HIT_STOP, text[a:b]) for a, b in frags)


@api_view(["GET"])
def search(request):
    q = request.query_params
    return Response(run(request.user, q.get("q", ""), q.get("faq") == "1", q.getlist("scope"), q.get("match") == "exact"))


class _Scopes:
    """The search filter: "private" (the own personal area), "team:<id>" (that team's area and the folders shared with it);
    nothing or "all" = everything. It only narrows what the user may read anyway, it never adds anything."""

    def __init__(self, user, values):
        from .models import NodePermission, Team
        self.all = not values or "all" in values
        self.private = "private" in values
        ids = {int(m.group(1)) for v in values if (m := SCOPE_TEAM.fullmatch(v))}
        self.team_area = {t.area_id: t for t in Team.objects.all() if t.area_id}  # every team: area -> team (for the group label)
        self.teams = {t.pk: t for t in self.team_area.values() if t.pk in ids}
        groups = {g: t for t in self.teams.values() for g in (t.read_group_id, t.write_group_id) if g}
        self.shared = {}  # team id -> ids of folders other teams shared with it
        for p in NodePermission.objects.filter(group_id__in=list(groups), node__kind=Node.FOLDER):
            self.shared.setdefault(groups[p.group_id].pk, set()).add(p.node_id)
        self.user = user

    def bucket(self, root):
        if root.owner_id is not None:
            return "private", None
        team = self.team_area.get(root.pk)
        if team:
            return "team", team
        return ("faq" if root.is_public else "other"), None

    def allows(self, chain):
        """chain = [area, …, node]."""
        if self.all:
            return True
        root = chain[0]
        if self.private and root.owner_id is not None and root.owner_id == getattr(self.user, "pk", None):
            return True
        team = self.team_area.get(root.pk)
        if team and team.pk in self.teams:
            return True
        return any(n.pk in self.shared.get(t, ()) for t in self.teams for n in chain)


def run(user, text, faq_only=False, scopes=(), exact=False):
    """Hits (max. 30) for a search text, only nodes the user may read; faq_only = the public FAQ's search box.
    All words must occur (title or content, any order). scopes narrows the hits to the own private area and/or teams.
    exact=True keeps only hits that contain the words as typed (whole words, "quoted" = phrase); the stemmed, prefix-based
    query still selects the candidates, so exact hits are always a subset of the normal ones."""
    query = to_query(text)
    if query is None:
        return []
    pats = exact_patterns(text) if exact else []
    scope = _Scopes(user, [str(v) for v in scopes])
    qs = (Node.objects.filter(deleted_at=None, search_vector=query)
          .annotate(rank=SearchRank(F("search_vector"), query),
                    snippet=SearchHeadline("search_text", query, config="german", start_sel=HIT_START,
                                           stop_sel=HIT_STOP, max_words=30, min_words=12, max_fragments=2,
                                           fragment_delimiter=" … "))
          .select_related("parent")
          .order_by("-rank", "title")[: 100 if scope.all and not exact else 500])  # a narrow filter looks deeper before the visibility check
    hits = []
    for n in qs:
        if not _visible(user, n) or (faq_only and not is_public(n)):
            continue
        chain = [*n.ancestors(), n]
        if not scope.allows(chain):
            continue
        if exact and not all(p.search(n.title) or p.search(n.search_text or "") for p in pats):
            continue
        kind, team = scope.bucket(chain[0])
        hits.append({"id": n.id, "kind": n.kind, "title": n.title,
                     "path": " / ".join(a.title for a in n.ancestors()),
                     "group": "Privat" if kind == "private" else chain[0].title,
                     "bucket": kind, "team": team.pk if team else None,
                     # ts_headline returns the start of the text when only the title matched.
                     "snippet": (exact_snippet(n.search_text, pats) if exact else n.snippet) if n.search_text else ""})
        if len(hits) == 30:
            break
    return hits
