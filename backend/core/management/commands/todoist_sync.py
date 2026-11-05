"""Sync every connected Todoist account (polling, no webhooks). Run every 5 minutes by a systemd timer."""
from django.core.management.base import BaseCommand

from core import todoist


class Command(BaseCommand):
    help = "Todoist-Abgleich für alle verbundenen Konten"

    def handle(self, *args, **opts):
        results = todoist.sync_all()
        if "skipped" in results:
            self.stdout.write("Todoist-Integration ist ausgeschaltet.")
            return
        for user, result in results.items():
            self.stdout.write(f"{user}: {result}")
