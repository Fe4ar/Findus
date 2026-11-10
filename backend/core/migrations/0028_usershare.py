import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0027_hidden_attachments"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="UserShare",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("can_write", models.BooleanField(default=False)),
                ("node", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="user_shares", to="core.node")),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="+", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name="usershare",
            constraint=models.UniqueConstraint(fields=("node", "user"), name="core_usershare_unique"),
        ),
    ]
