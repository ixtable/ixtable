// Writes tests/fixtures/archives/format-<FORMAT_VERSION>/ (one .ixt per golden app
// plus manifest.json) with the current build. Run once when the archive format
// version changes, then commit the new directory. Existing directories are never
// rewritten: the Rust test refuses to overwrite them. `--format-1` instead
// derives tests/fixtures/archives/format-1/ from format-2/ by writing the same
// documents in the legacy format 1 layout (see fixtures.rs).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const result = spawnSync(
  "cargo",
  [
    "test",
    "--lib",
    process.argv.includes("--format-1")
      ? "durability_tests::fixtures::write_format_1_archive_fixtures"
      : "durability_tests::fixtures::write_archive_fixtures",
    "--",
    "--exact",
    "--ignored",
  ],
  { cwd: join(root, "src-tauri"), stdio: "inherit" },
);
process.exit(result.status ?? 1);
