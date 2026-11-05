import django.contrib.postgres.fields
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0015_drop_legacy_groups")]

    operations = [
        migrations.AddField(
            model_name="team",
            name="disabled_features",
            field=django.contrib.postgres.fields.ArrayField(base_field=models.CharField(max_length=20), blank=True, default=list, size=None),
        ),
    ]
