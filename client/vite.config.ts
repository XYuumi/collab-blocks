import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:3000", ws: true },
      "/api": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
