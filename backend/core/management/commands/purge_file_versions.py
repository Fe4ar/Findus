"""Retention of old file versions per team (set by the team leader). Default: nothing is deleted.

Rule: a version of a file in a team's area is deleted only if it is older than the team's file_keep_days AND no longer among the
file's newest file_keep_versions versions. The newest version is never deleted. Teams without both values are skipped.
Run daily (called by purge_trash, i.e. the existing purge timer)."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core import audit
from core.models import FileVersion, Node, Team


def _root_id(node):
    while node.parent_id:
        node = node.parent
    return node.pk


def doomed_versions(team, now):
    """FileVersions of this team's live files that the rule removes."""
    cutoff = now - timedelta(days=team.file_keep_days)
    out = []
    for node in Node.objects.filter(kind=Node.FILE, deleted_at=None, space=Node.WIKI).select_related("parent"):
        if _root_id(node) != team.area_id:
            continue
        versions = list(node.file_versions.order_by("-created_at", "-id"))  # newest first
        out += [v for v in versions[max(team.file_keep_versions, 1):] if v.created_at < cutoff]
    return out


class Command(BaseCommand):
    help = "Alte Datei-Versionen nach der Aufbewahrung des Teams löschen (Standard: alles behalten)"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, dry_run=False, **opts):
        now = timezone.now()
        for team in Team.objects.filter(file_keep_versions__isnull=False, file_keep_days__isnull=False, area__isnull=False):
            doomed = doomed_versions(team, now)
            if not doomed:
                continue
            self.stdout.write(f"{'würde löschen' if dry_run else 'lösche'}: {len(doomed)} Datei-Versionen im Team {team.name}")
            if dry_run:
                continue
            FileVersion.objects.filter(pk__in=[v.pk for v in doomed]).delete()  # post_delete removes files nobody uses any more
            audit.log(None, "delete", team=team, username="System", what="Alte Dateiversionen aufgeräumt", anzahl=len(doomed),
                      regel=f"älter als {team.file_keep_days} Tage und nicht unter den neuesten {team.file_keep_versions}")
