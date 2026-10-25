import { defineConfig } from "vite-plus";

export default defineConfig({
  css: {
    lightningcss: { errorRecovery: true },
  },
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
