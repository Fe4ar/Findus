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


@api_view(["GET"])
def search(request):
    query = to_query(request.query_params.get("q", ""))
    if query is None:
        return Response([])
    qs = (Node.objects.filter(deleted_at=None, search_vector=query)
          .annotate(rank=SearchRank(F("search_vector"), query),
                    snippet=SearchHeadline("search_text", query, config="german", start_sel=HIT_START,
                                           stop_sel=HIT_STOP, max_words=30, min_words=12, max_fragments=2,
                                           fragment_delimiter=" … "))
          .select_related("parent")
          .order_by("-rank", "title")[:100])
    hits = []
    faq_only = request.query_params.get("faq") == "1"  # the public FAQ's search box: only public content
    for n in qs:
        if not _visible(request.user, n) or (faq_only and not is_public(n)):
            continue
        hits.append({"id": n.id, "kind": n.kind, "title": n.title,
                     "path": " / ".join(a.title for a in n.ancestors()),
                     # ts_headline returns the start of the text when only the title matched.
                     "snippet": n.snippet if n.search_text else ""})
        if len(hits) == 30:
            break
    return Response(hits)
