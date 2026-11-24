import { defineConfig } from "vite";

// In development, the page comes from Vite and the multiplayer server runs separately
// (npm run server); /ws is passed through to it. REDO_BASE is the path the built page is
// served from: "/" on cuboid, "/redo/" on mark-schachner.com.
export default defineConfig({
  base: process.env.REDO_BASE ?? "/",
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/info": "http://localhost:8787",
    },
  },
});
