import { defineConfig } from "vite";

// In development, the page comes from Vite and the multiplayer server runs separately
// (npm run server); /ws is passed through to it.
export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/info": "http://localhost:8787",
    },
  },
});
