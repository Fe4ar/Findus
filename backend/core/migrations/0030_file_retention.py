from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0029_audit_action_clear")]

    operations = [
        migrations.AddField(model_name="team", name="file_keep_versions", field=models.PositiveIntegerField(blank=True, null=True)),
        migrations.AddField(model_name="team", name="file_keep_days", field=models.PositiveIntegerField(blank=True, null=True)),
    ]
