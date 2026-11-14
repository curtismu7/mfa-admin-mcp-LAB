import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on PORT (default 7815); Vite on VITE_PORT (default 5202); /api is proxied.
const api = { target: `http://127.0.0.1:${Number(process.env.PORT) || 7815}` };
export default defineConfig({
  // Relative base: works served at '/', under the lab-proxy's /mfa-admin-mcp/, and direct on
  // :7815. A fixed '/mfa-admin-mcp/' base breaks direct serving — the e2e proved it (blank
  // page: the html pointed at /mfa-admin-mcp/assets on an origin serving '/').
  base: "./",
  plugins: [react()],
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
  server: { host: "127.0.0.1", port: Number(process.env.VITE_PORT) || 5202, strictPort: true, proxy: { "/api": api } },
});
