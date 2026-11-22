import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" + roteamento por hash (#/...) => funciona em qualquer subcaminho do GitHub Pages
// (https://usuario.github.io/NOME-DO-REPO/) sem configurar nada e sem erro 404 ao recarregar.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist", sourcemap: false },
});
