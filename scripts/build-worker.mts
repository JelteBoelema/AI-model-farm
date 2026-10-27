// Bundles the worker entrypoint into dist/worker/main.mjs. Dependencies stay external and are
// installed in the image; only our own source (incl. "@/..." path aliases) is bundled.
import { build } from "esbuild";

await build({
  entryPoints: ["src/workers/main.ts"],
  outfile: "dist/worker/main.mjs",
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
