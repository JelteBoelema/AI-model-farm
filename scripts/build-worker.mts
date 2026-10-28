// Bundles the worker entrypoint into dist/worker/main.mjs (and the queue rebuild, used after a Redis
// loss, into dist/worker/rebuild.mjs). Dependencies stay external and are
// installed in the image; only our own source (incl. "@/..." path aliases) is bundled.
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/workers/main.ts", rebuild: "scripts/rebuild-queues.ts" },
  outdir: "dist/worker",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
