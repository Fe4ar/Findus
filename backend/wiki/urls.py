from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("core.urls")),
]

try:  # optional local extension package next to core; absent in a plain checkout
    from local_ext.urls import urlpatterns as _local

    urlpatterns += _local
except ModuleNotFoundError as e:
    if e.name != "local_ext" and not str(e.name).startswith("local_ext."):
        raise
