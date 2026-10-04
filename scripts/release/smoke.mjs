#!/usr/bin/env node
// Smoke launch for a release binary (release.yml `build`): starts the app with a
// throwaway state dir and passes when it is still running after the grace period.
// usage: smoke.mjs <binary> [seconds]   (Linux: run under xvfb-run)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [binary, seconds = "20"] = process.argv.slice(2);
if (!binary) {
  console.error("usage: smoke.mjs <binary> [seconds]");
  process.exit(2);
}
const stateDir = mkdtempSync(join(tmpdir(), "ixtable-smoke-"));
const child = spawn(binary, [], {
  env: { ...process.env, IXTABLE_STATE_DIR: stateDir },
  stdio: "inherit",
});
let exited = null;
child.on("exit", (code, signal) => {
  exited = { code, signal };
});
child.on("error", (error) => {
  console.error(`::error::Could not start ${binary}: ${error.message}`);
  process.exit(1);
});
setTimeout(() => {
  if (exited) {
    console.error(`::error::ixtable exited during the smoke launch (${JSON.stringify(exited)})`);
    process.exit(1);
  }
  console.log(`ixtable ran for ${seconds}s without exiting`);
  child.kill();
  process.exit(0);
}, Number(seconds) * 1000);
