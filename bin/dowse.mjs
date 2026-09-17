#!/usr/bin/env node
// `dowse` launcher: OpenTUI needs Node with `--experimental-ffi` plus the
// tsx ESM loader for TypeScript. Plain `node bin/dowse.mjs` won't have them,
// so re-exec once with the right flags, then boot the app.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (!process.env.DOWSE_BOOTED) {
  const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-ffi",
      "--no-warnings",
      "--import",
      tsxLoader,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: { ...process.env, DOWSE_BOOTED: "1" } },
  );
  process.exit(result.status ?? 1);
}

await import("../src/index.tsx");
