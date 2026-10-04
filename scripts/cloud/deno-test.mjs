#!/usr/bin/env node
// Type-checks every Edge Function and runs the Deno unit tests for
// supabase/functions/**/*_test.ts. Deno comes from npm (`npx deno@2`), so no
// separate install is needed. These tests need no running stack.
//
//   node scripts/cloud/deno-test.mjs [extra deno test args]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const functionsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "functions",
);
const DENO = "deno@2.9.6";
const shell = process.platform === "win32";

function deno(args) {
  const result = spawnSync("npx", ["--yes", DENO, ...args], {
    cwd: functionsDir,
    stdio: "inherit",
    shell,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(join(functionsDir, "node_modules"))) {
  const install = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: functionsDir,
    stdio: "inherit",
    shell,
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const entrypoints = readdirSync(functionsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(functionsDir, entry.name, "index.ts")))
  .map((entry) => `${entry.name}/index.ts`);
deno(["check", "_shared/", ...entrypoints]);
deno(["test", "--allow-env", "--allow-read=.", "--no-prompt", ...process.argv.slice(2)]);
