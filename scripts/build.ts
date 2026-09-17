// Build a standalone dowse executable with `mise exec -- bun ./scripts/build.ts`.
// Targets glibc Linux x64 (define strips the unused musl branch — see
// https://opentui.com/docs/reference/standalone-executables#linux-libc).
const result = await Bun.build({
  entrypoints: ["./src/index.tsx"],
  compile: {
    target: "bun-linux-x64",
    outfile: "./dist/dowse-linux-x64",
  },
  define: {
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("Built ./dist/dowse-linux-x64");
