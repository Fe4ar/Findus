import django.contrib.postgres.fields
from django.db import migrations, models

import core.models


def switch_off(apps, schema_editor):
    """Aufgaben and Netzwerk now need an admin's release: existing teams start without them."""
    Team = apps.get_model("core", "Team")
    for t in Team.objects.all():
        t.disabled_features = sorted(set(t.disabled_features) | {"tasks", "network"})
        t.save(update_fields=["disabled_features"])


class Migration(migrations.Migration):

    dependencies = [("core", "0021_login_throttle")]

    operations = [
        migrations.AlterField(
            model_name="team",
            name="disabled_features",
            field=django.contrib.postgres.fields.ArrayField(base_field=models.CharField(max_length=20), blank=True, default=core.models.default_disabled_features, size=None),
        ),
        migrations.RunPython(switch_off, migrations.RunPython.noop),
    ]
