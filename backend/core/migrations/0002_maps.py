# Maps become nodes in their own tree ("karte" space); the former backend/karte.json becomes the first map.
from django.db import migrations, models

# Fictional example map for new installations (RFC 5737 addresses); existing databases keep their map.
TESTKARTE = {'testdaten': True,
 'hinweis': 'Beispielkarte mit erfundenen Geräten (Adressen aus 192.0.2.0/24, RFC 5737). Mit „Bearbeiten“ '
            'eigene Geräte eintragen.',
 'elements': [{'id': 'rack', 'type': 'rack', 'x': 20, 'y': 20, 'w': 320, 'name': 'Rack', 'units': 12},
              {'id': 'router',
               'type': 'device',
               'name': 'Router',
               'icon': '📡',
               'ip': '192.0.2.1',
               'check': 'http://192.0.2.1',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 0,
               'y': 0,
               'rack': {'id': 'rack', 'u': 12, 'h': 1}},
              {'id': 'switch',
               'type': 'switch',
               'name': 'Switch',
               'icon': '🔀',
               'ip': '192.0.2.6',
               'check': 'http://192.0.2.6',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 0,
               'y': 0,
               'ports': 24,
               'rack': {'id': 'rack', 'u': 11, 'h': 1}},
              {'id': 'hv',
               'type': 'device',
               'name': 'Hypervisor',
               'icon': '🖥️',
               'ip': '192.0.2.10',
               'check': 'https://192.0.2.10:8006',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 0,
               'y': 0,
               'rack': {'id': 'rack', 'u': 9, 'h': 2}},
              {'id': 'nas',
               'type': 'device',
               'name': 'NAS',
               'icon': '💾',
               'ip': '192.0.2.7',
               'check': 'https://192.0.2.7',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 0,
               'y': 0,
               'rack': {'id': 'rack', 'u': 6, 'h': 2}},
              {'id': 'wiki',
               'type': 'device',
               'name': 'Findus (VM)',
               'icon': '📚',
               'ip': '192.0.2.4',
               'check': 'https://192.0.2.4',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 380,
               'y': 20},
              {'id': 'ap',
               'type': 'device',
               'name': 'WLAN-AP',
               'icon': '📶',
               'ip': '192.0.2.50',
               'check': 'http://192.0.2.50',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 380,
               'y': 100},
              {'id': 'printer',
               'type': 'device',
               'name': 'Drucker',
               'icon': '🖨️',
               'ip': '192.0.2.103',
               'check': 'http://192.0.2.103',
               'color': '',
               'w': 170,
               'h': 56,
               'x': 380,
               'y': 180},
              {'id': 'link-switch',
               'type': 'link',
               'from': 'switch',
               'to': 'router',
               'label': 'Port 24',
               'color': ''},
              {'id': 'link-hv', 'type': 'link', 'from': 'hv', 'to': 'switch', 'label': 'Port 1', 'color': ''},
              {'id': 'link-nas',
               'type': 'link',
               'from': 'nas',
               'to': 'switch',
               'label': 'Port 2',
               'color': ''},
              {'id': 'link-wiki', 'type': 'link', 'from': 'wiki', 'to': 'hv', 'label': '', 'color': ''},
              {'id': 'link-ap',
               'type': 'link',
               'from': 'ap',
               'to': 'switch',
               'label': 'Port 10',
               'color': ''},
              {'id': 'link-printer',
               'type': 'link',
               'from': 'printer',
               'to': 'ap',
               'label': '',
               'color': ''}]}


def add_testkarte(apps, schema_editor):
    Node = apps.get_model("core", "Node")
    PageRevision = apps.get_model("core", "PageRevision")
    if Node.objects.filter(space="karte", kind="map", title="Testkarte").exists():
        return
    folder = Node.objects.create(kind="folder", space="karte", title="Netzwerk", position=0)
    node = Node.objects.create(kind="map", space="karte", parent=folder, title="Testkarte", position=0)
    PageRevision.objects.create(node=node, content=TESTKARTE, comment="Übernommen aus karte.json")


def remove_testkarte(apps, schema_editor):
    apps.get_model("core", "Node").objects.filter(space="karte").delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="node",
            name="space",
            field=models.CharField(choices=[("wiki", "Wiki"), ("karte", "Karten")], default="wiki", max_length=10),
        ),
        migrations.AlterField(
            model_name="node",
            name="kind",
            field=models.CharField(choices=[("area", "Bereich"), ("folder", "Ordner"), ("page", "Seite"),
                                            ("file", "Datei"), ("map", "Karte")], max_length=10),
        ),
        migrations.RunPython(add_testkarte, remove_testkarte),
    ]
