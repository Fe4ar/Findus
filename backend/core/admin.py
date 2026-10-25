from django.contrib import admin

from .models import FileVersion, Node, PageRevision


@admin.register(Node)
class NodeAdmin(admin.ModelAdmin):
    list_display = ("title", "kind", "parent", "status", "updated_at", "deleted_at")
    list_filter = ("kind", "status")
    search_fields = ("title",)


admin.site.register(PageRevision)
admin.site.register(FileVersion)
