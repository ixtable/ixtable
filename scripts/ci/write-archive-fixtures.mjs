// Writes tests/fixtures/archives/format-<FORMAT_VERSION>/ (one .ixt per golden app
// plus manifest.json) with the current build. Run once when the archive format
// version changes, then commit the new directory. Existing directories are never
// rewritten: the Rust test refuses to overwrite them.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = spawnSync(
  "cargo",
  [
    "test",
    "--lib",
    "durability_tests::fixtures::write_archive_fixtures",
    "--",
    "--exact",
    "--ignored",
  ],
  { cwd: join(root, "src-tauri"), stdio: "inherit" },
);
process.exit(result.status ?? 1);
