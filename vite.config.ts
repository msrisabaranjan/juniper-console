import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// `npm run dev:https` (vite --mode https) serves over https with a throwaway
// self-signed cert: geolocation is a secure-context API, and in the car the
// page is reached by LAN IP (https://localhost only works on the dev machine).
export default defineConfig(({ command, mode }) => ({
  // GitHub Pages serves the site under /juniper-console/ — only the deployed
  // build needs the subpath base; the dev server stays rooted at /.
  base: command === "build" ? "/juniper-console/" : "/",
  plugins: mode === "https" ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    sourcemap: false,
  },
}));
