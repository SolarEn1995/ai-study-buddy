import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite 會自動把 public/ 內的檔案複製到輸出根目錄（含 sw.js、manifest.webmanifest、icons/）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
