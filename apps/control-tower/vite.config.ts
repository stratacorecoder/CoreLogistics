import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@corelogistics/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@corelogistics/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    },
  },
  server: { port: 5180, strictPort: true, host: true },
});
