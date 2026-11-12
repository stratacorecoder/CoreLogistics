import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@corelogistics/contracts": path.resolve(__dirname, "../../packages/contracts/src/index.ts"),
      "@corelogistics/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    },
  },
  server: { port: 5182, strictPort: true, host: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/motion/") || id.includes("/node_modules/framer-motion/")) {
            return "vendor-motion";
          }
          if (id.includes("/node_modules/gsap/") || id.includes("/node_modules/@gsap/")) {
            return "vendor-gsap";
          }
        },
      },
    },
  },
});
