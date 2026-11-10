from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("core", "0028_usershare")]

    operations = [
        migrations.AlterField(
            model_name="auditlog",
            name="action",
            field=models.CharField(choices=[(a, a) for a in ("create", "update", "delete", "move", "restore", "publish", "permissions", "login", "login_failed", "login_locked", "logout", "team", "user", "audit")], max_length=20),
        ),
    ]
