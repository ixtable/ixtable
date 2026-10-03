#!/usr/bin/env node
// Builds the NAPI test bridge (src-tauri lib with the `test-bridge` feature) and
// copies the tauri-test loader to target/index.cjs so ESM tests can require() it.
// Cross-platform replacement for `RUSTC_WRAPPER= cargo build ... && cp ...`.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const crate = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src-tauri");
// tauri-test always writes its loader to <crate>/target/index.js (even with
// CARGO_TARGET_DIR set), and the loader only searches `target/` dirs next to the crate.
const targetDir = join(crate, "target");

// An empty RUSTC_WRAPPER disables any wrapper (sccache) set in cargo config;
// the bridge cdylib must be built by plain rustc.
const result = spawnSync("cargo", ["build", "--lib", "--features", "test-bridge"], {
  cwd: crate,
  stdio: "inherit",
  env: { ...process.env, RUSTC_WRAPPER: "" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const loader = join(targetDir, "index.js");
if (!existsSync(loader)) {
  console.error(`build-test-bridge: tauri-test did not write ${loader}`);
  process.exit(1);
}
copyFileSync(loader, join(targetDir, "index.cjs"));
