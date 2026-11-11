from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0030_file_retention")]

    operations = [
        migrations.AddField(model_name="integrationsettings", name="idle_logout_minutes", field=models.PositiveIntegerField(default=240)),
    ]
