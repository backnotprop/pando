import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev` serves the app here and sends the API to a local `wrangler dev`
// (PANDO_DEV_WORKER). Writes and sockets must carry the Worker's own Origin.
const worker = process.env.PANDO_DEV_WORKER ?? "http://localhost:8813";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    proxy: {
      "/v1": { target: worker, ws: true, changeOrigin: true, headers: { origin: worker } },
    },
  },
});
