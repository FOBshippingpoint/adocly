import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      // Asciidoctor ships this stylesheet but does not expose it in package exports.
      "@asciidoctor/core/dist/css/asciidoctor.css": new URL(
        "./node_modules/@asciidoctor/core/dist/css/asciidoctor.css",
        import.meta.url,
      ).pathname,
    },
  },
});
