import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Two entry points: the app (index.html) and the logged-out help portal (hilfe/index.html, served under /hilfe/).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), hilfe: resolve(__dirname, "hilfe/index.html") } },
  },
});
