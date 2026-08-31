import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/samples": "http://127.0.0.1:3001",
      "/workspace": "http://127.0.0.1:3001",
      "/outputs": "http://127.0.0.1:3001"
    }
  },
  build: { outDir: "dist" }
});
