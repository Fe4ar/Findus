"""Fresh installation only (no user exists yet): create the start admin "admin" with a known password that must be changed
at the first login. Runs at every start of the web container and does nothing once any user exists."""
from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import UserSettings

START_USER, START_PASSWORD = "admin", "admin1234!"


class Command(BaseCommand):
    help = "Create the start admin on an installation without any user"

    def handle(self, *args, **options):
        User = get_user_model()
        with transaction.atomic():
            if User.objects.select_for_update().exists():
                return
            user = User.objects.create_superuser(START_USER, "", START_PASSWORD)
            UserSettings.objects.update_or_create(user=user, defaults={"must_change_password": True})
        self.stdout.write(f"Start admin {START_USER!r} created; the password must be changed at the first login.")
