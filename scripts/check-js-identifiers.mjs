// Fails when any JS file references an identifier that is not defined or
// imported (TS2304 / TS2552 / TS2662 under `checkJs`). Plain `node --check`
// only catches syntax; a removed variable still referenced in a handler is a
// runtime ReferenceError → 500 on the first request. This is the gate.
//
// Usage: node scripts/check-js-identifiers.mjs [files...]
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const DIRS = ["controllers", "middleware", "models", "routes", "services", "utils", "scripts", "jobs", "index.js"];
const slash = (p) => p.replace(/\\/g, "/");

function walk(p, out) {
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p)) if (name !== "node_modules") walk(join(p, name), out);
  } else if ([".js", ".mjs", ".cjs"].includes(extname(p))) out.push(p);
  return out;
}
const files = (args.length ? args.map((f) => resolve(root, f)) : DIRS.flatMap((d) => walk(join(root, d), [])))
  .filter((f) => [".js", ".mjs", ".cjs"].includes(extname(f)));

const dir = mkdtempSync(join(tmpdir(), "checkjs-"));
const tsconfig = join(dir, "tsconfig.json");
writeFileSync(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      target: "es2022",
      module: "nodenext",
      moduleResolution: "nodenext",
      types: ["node"],
      typeRoots: [slash(join(root, "node_modules", "@types"))],
    },
    include: files.map(slash),
  }),
);
const tscJs = join(root, "node_modules", "typescript", "lib", "tsc.js");
const result = spawnSync(process.execPath, [tscJs, "-p", tsconfig], { encoding: "utf8" });
const lines = (result.stdout + result.stderr)
  .split(/\r?\n/)
  .filter((l) => /error TS(2304|2552|2662):/.test(l) && !l.includes("node_modules"));
if (lines.length) {
  console.error(`check-js-identifiers: ${lines.length} undefined identifier(s):`);
  for (const l of lines) console.error("  " + l);
  process.exit(1);
}
console.log(`check-js-identifiers: OK (${files.length} files)`);
