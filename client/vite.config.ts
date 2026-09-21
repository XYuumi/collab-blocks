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
      "/ws": { target: "ws://localhost:28365", ws: true },
      "/api": { target: "http://localhost:28365", changeOrigin: true },
    },
  },
});
