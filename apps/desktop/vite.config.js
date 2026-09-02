import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: {
        host: "127.0.0.1",
        port: 1420,
        strictPort: true,
    },
    envPrefix: ["VITE_", "TAURI_"],
    build: {
        target: ["es2021", "chrome100", "safari13"],
        minify: process.env.TAURI_DEBUG ? false : "esbuild",
        sourcemap: Boolean(process.env.TAURI_DEBUG),
    },
});
