import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("core", "0018_wopi_collabora"),
    ]

    operations = [
        migrations.AddField(
            model_name="task",
            name="updated_at",
            field=models.DateTimeField(auto_now=True, default=django.utils.timezone.now),
            preserve_default=False,
        ),
        migrations.CreateModel(
            name="IntegrationSettings",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("todoist_allowed", models.BooleanField(default=True)),
            ],
        ),
        migrations.CreateModel(
            name="TaskEvent",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("at", models.DateTimeField(auto_now_add=True)),
                ("text", models.CharField(max_length=300)),
                ("task", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="events", to="core.task")),
            ],
            options={"ordering": ["-at", "-id"]},
        ),
        migrations.CreateModel(
            name="TodoistLink",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("token_enc", models.TextField()),
                ("connected_at", models.DateTimeField()),
                ("project_id", models.CharField(max_length=40)),
                ("project_name", models.CharField(max_length=200)),
                ("sync_token", models.TextField(blank=True)),
                ("include_private", models.BooleanField(default=False)),
                ("import_new", models.BooleanField(default=True)),
                ("last_sync_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.CharField(blank=True, max_length=300)),
                ("last_error_at", models.DateTimeField(blank=True, null=True)),
                ("syncing", models.BooleanField(default=False)),
                ("sync_started_at", models.DateTimeField(blank=True, null=True)),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name="todoist", to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.CreateModel(
            name="TodoistItem",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("todoist_id", models.CharField(max_length=40)),
                ("state", models.JSONField(default=dict)),
                ("link", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="items", to="core.todoistlink")),
                ("task", models.OneToOneField(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="todoist_item", to="core.task")),
            ],
        ),
        migrations.AddConstraint(
            model_name="todoistitem",
            constraint=models.UniqueConstraint(fields=("link", "todoist_id"), name="core_todoistitem_unique"),
        ),
    ]
