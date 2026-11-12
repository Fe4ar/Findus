// Apply the last theme before the first paint (no flash); main.tsx then syncs it with the account setting.
try { var t = localStorage.getItem("theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
