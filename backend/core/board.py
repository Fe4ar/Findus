"""Task board: ~/jobs/board.md from CT 103, pushed into the read-only /board mount by cron."""
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from rest_framework.decorators import api_view
from rest_framework.exceptions import NotFound
from rest_framework.response import Response

from .permissions import READ, can

BOARD_FILE = Path(os.environ.get("BOARD_FILE", "/board/board.md"))
COLUMNS = ("nr", "task", "who", "status", "note")


def parse(text):
    """Rows of the first markdown table with exactly the five board columns; header and separator are skipped."""
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            continue
        # Cells may contain escaped pipes ("\|") and escaped slashes ("\/").
        cells = [c.strip().replace("\\|", "|").replace("\\/", "/") for c in re.split(r"(?<!\\)\|", line.strip("|"))]
        if len(cells) != len(COLUMNS) or cells[0].lower() == "nr" or set(cells[0]) <= set("-: "):
            continue
        rows.append(dict(zip(COLUMNS, cells)))
    return rows


@api_view(["GET"])
def board(request):
    if not can(request.user, READ):
        raise NotFound()
    try:
        text = BOARD_FILE.read_text(encoding="utf-8")
        updated = datetime.fromtimestamp(BOARD_FILE.stat().st_mtime, timezone.utc)
    except FileNotFoundError:
        return Response({"updated": None, "rows": []})
    return Response({"updated": updated, "rows": parse(text)})
