from django.urls import path

from . import board, export, files, maps, search, services, views

urlpatterns = [
    path("api/health", views.health),
    path("api/auth/login", views.auth_login),
    path("api/auth/logout", views.auth_logout),
    path("api/auth/me", views.auth_me),
    path("api/services", services.services),
    path("api/board", board.board),
    path("api/maps/<uuid:node_id>/status", maps.map_status),
    path("api/pages", maps.page_list),
    path("api/nodes/<uuid:node_id>/maps", maps.page_maps),
    path("api/nodes/<uuid:node_id>/export", export.export_node),
    path("api/search", search.search),
    path("api/tree", views.tree),
    path("api/nodes", views.node_create),
    path("api/nodes/<uuid:node_id>", views.node_view),
    path("api/nodes/<uuid:node_id>/history", views.history),
    path("api/nodes/<uuid:node_id>/history/<int:rev_id>", views.history_revision),
    path("api/nodes/<uuid:node_id>/history/<int:rev_id>/restore", views.history_restore),
    path("api/pages/<uuid:node_id>/content", views.page_content),
    path("api/files", files.file_upload),
    path("api/files/<uuid:node_id>/versions", files.file_new_version),
    path("api/files/<uuid:node_id>/versions/<uuid:version_id>/restore", files.file_restore),
    path("api/files/<uuid:node_id>/onlyoffice-config", files.onlyoffice_config),
    path("media-dl/<uuid:version_id>", files.media_download),
    # Reachable only inside the compose network; caddy answers /internal/* with 404.
    path("internal/oo-download/<str:token>", files.oo_download),
    path("internal/oo-callback/<str:token>", files.oo_callback),
    path("internal/export-html/<str:token>", export.export_html_file),
]
