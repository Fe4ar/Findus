import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0022_optin_features"), migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.AddField(
            model_name="node",
            name="owner",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="private_areas", to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(model_name="integrationsettings", name="user_retention_days", field=models.PositiveIntegerField(default=30)),
        migrations.AddField(model_name="usersettings", name="deleted_at", field=models.DateTimeField(blank=True, null=True)),
    ]
