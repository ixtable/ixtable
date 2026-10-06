// Runs the `#[ignore]`d Rust tests a CI job provides the environment for, and
// fails unless every one of them ran and passed. The expected names come from
// `cargo test -- --list --ignored <filters>`, so a test cannot drop out unseen,
// and a test that returned early cannot pass: under CI a missing variable
// panics (src-tauri/src/test_env.rs). Non-ignored tests matching the filters
// run too (`--include-ignored`).
// Usage: node scripts/ci/run-ignored-rust-tests.mjs [--release] <label> [libtest args...]
// Example: node scripts/ci/run-ignored-rust-tests.mjs "PostgreSQL" recordstore postgres --skip perf_tests
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const release = argv[0] === "--release";
if (release) argv.shift();
const [label, ...libtest] = argv;
if (!label) {
  console.error("usage: run-ignored-rust-tests.mjs [--release] <label> [libtest args...]");
  process.exit(2);
}
const cwd = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src-tauri");
const cargo = (args, capture) =>
  spawnSync("cargo", ["test", ...(release ? ["--release"] : []), "--lib", "--", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });

const listed = cargo(["--list", "--ignored", ...libtest], true);
if (listed.status !== 0) {
  process.stdout.write(listed.stdout ?? "");
  console.error(`${label}: listing the ignored tests failed`);
  process.exit(1);
}
const expected = [...listed.stdout.matchAll(/^(\S+): test$/gm)].map((m) => m[1]);
if (expected.length === 0) {
  console.error(`${label}: no ignored tests match ${libtest.join(" ")}`);
  process.exit(1);
}
console.log(
  `${label}: ${expected.length} ignored tests expected to run:\n  ${expected.join("\n  ")}`,
);

const run = cargo(["--include-ignored", ...libtest], true);
process.stdout.write(run.stdout ?? "");
const outcome = new Map(
  [...(run.stdout ?? "").matchAll(/^test (\S+) \.\.\. (\w+)/gm)].map((m) => [m[1], m[2]]),
);
const bad = expected.filter((name) => outcome.get(name) !== "ok");
for (const name of bad) console.error(`${label}: ${name}: ${outcome.get(name) ?? "did not run"}`);
if (run.status !== 0 || bad.length > 0) {
  console.error(`${label}: failed (cargo exit ${run.status}, ${bad.length} expected tests not ok)`);
  process.exit(1);
}
console.log(`${label}: all ${expected.length} ignored tests ran and passed`);
