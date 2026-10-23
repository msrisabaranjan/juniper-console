import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  use: { baseURL: "http://localhost:5199" },
  webServer: {
    command: "npx vite --port 5199 --strictPort",
    port: 5199,
    reuseExistingServer: true,
  },
});
