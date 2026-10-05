// Starts a throwaway PostgreSQL server on the runner and exports
// IXTABLE_TEST_POSTGRES_URL (GitHub service containers are Linux-only, so the
// macOS and Windows conformance jobs run PostgreSQL natively). Uses the
// runner's preinstalled binaries ($PGBIN on Windows), Homebrew postgresql@16 on
// macOS (installed when missing), or whatever initdb is on PATH. The cluster
// lives under $RUNNER_TEMP (or the OS temp dir) with password authentication.
// Usage: node scripts/ci/start-postgres.mjs [port]
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv[2] || "5432";
const user = "ixtable";
// Distinct from every other value so tests can assert it never lands in a document.
const password = "pg-secret-7f3a";
const database = "ixtable_test";
const exe = process.platform === "win32" ? ".exe" : "";

const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
const output = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function binDir() {
  if (process.env.PGBIN && existsSync(join(process.env.PGBIN, `initdb${exe}`))) {
    return process.env.PGBIN;
  }
  if (process.platform === "darwin") {
    try {
      return join(output("brew", ["--prefix", "--installed", "postgresql@16"]), "bin");
    } catch {
      run("brew", ["install", "postgresql@16"], { HOMEBREW_NO_AUTO_UPDATE: "1" });
      return join(output("brew", ["--prefix", "postgresql@16"]), "bin");
    }
  }
  try {
    return output("pg_config", ["--bindir"]);
  } catch {
    return "";
  }
}

const bin = binDir();
const tool = (name) => (bin ? join(bin, `${name}${exe}`) : name);
const root = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "ixtable-pg-"));
const data = join(root, "data");
const pwfile = join(root, "pwfile");
writeFileSync(pwfile, `${password}\n`);

run(tool("initdb"), [
  "-D",
  data,
  "-U",
  user,
  `--pwfile=${pwfile}`,
  "--auth=scram-sha-256",
  "--encoding=UTF8",
  "--no-locale",
]);
run(tool("pg_ctl"), [
  "-D",
  data,
  "-l",
  join(root, "server.log"),
  "-o",
  `-p ${port} -c listen_addresses=localhost`,
  "-w",
  "start",
]);
run(tool("createdb"), ["-h", "localhost", "-p", port, "-U", user, database], {
  PGPASSWORD: password,
});

const url = `postgresql://${user}:${password}@localhost:${port}/${database}?sslmode=disable`;
if (process.env.GITHUB_ENV)
  appendFileSync(process.env.GITHUB_ENV, `IXTABLE_TEST_POSTGRES_URL=${url}\n`);
console.log(`PostgreSQL ready (${data}); IXTABLE_TEST_POSTGRES_URL=${url}`);
