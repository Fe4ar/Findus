import json
from pathlib import Path

from django.conf import settings
from django.db import migrations


def services_to_global(apps, schema_editor):
    """The entries of services.json become global shortcuts (one category per group), so nothing is lost."""
    Cat, Shortcut = apps.get_model("core", "ShortcutCategory"), apps.get_model("core", "Shortcut")
    f = Path(settings.BASE_DIR) / "services.json"
    if not f.exists() or Cat.objects.filter(user=None, team=None).exists():
        return
    cats = {}
    for s in json.loads(f.read_text(encoding="utf-8")):
        cat = cats.get(s["group"]) or cats.setdefault(s["group"], Cat.objects.create(name=s["group"], position=len(cats)))
        Shortcut.objects.create(category=cat, name=s["name"], url=s["url"], icon=s.get("icon") or "🔗", position=cat.shortcuts.count())


class Migration(migrations.Migration):
    dependencies = [("core", "0010_dashboard_shortcuts")]
    operations = [migrations.RunPython(services_to_global, migrations.RunPython.noop)]
