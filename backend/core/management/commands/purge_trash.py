"""Delete trashed items for good once their team's retention (default 40 days) has passed. Run daily by a systemd timer."""
from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from core import admin_api
from core.models import IntegrationSettings, Node, PageView, UserSettings


class Command(BaseCommand):
    help = "Endgültiges Löschen abgelaufener Papierkorb-Einträge"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, dry_run=False, **opts):
        now, n = timezone.now(), 0
        for node in list(admin_api._trash_roots()):
            if node.deleted_at + timedelta(days=admin_api._days(node)) <= now:
                n += 1
                self.stdout.write(f"{'würde löschen' if dry_run else 'lösche'}: {node.title} ({node.deleted_at:%Y-%m-%d})")
                if not dry_run:
                    admin_api.purge(node)
        # Deleted users: after the retention their personal area and the account go for good.
        retention = timedelta(days=IntegrationSettings.retention_days())
        for st in UserSettings.objects.filter(deleted_at__isnull=False, deleted_at__lte=now - retention).select_related("user"):
            self.stdout.write(f"{'würde löschen' if dry_run else 'lösche'}: Nutzer {st.user.username} samt privatem Bereich")
            if not dry_run:
                for area in Node.objects.filter(owner=st.user, parent=None):
                    admin_api.purge(area)
                st.user.delete()
        # Raw page views older than 90 days go; PageCounter keeps the totals.
        old = PageView.objects.filter(at__lt=now - timedelta(days=90))
        self.stdout.write(f"{n} Einträge im Papierkorb, {old.count()} alte Aufrufe")
        if not dry_run:
            old.delete()
