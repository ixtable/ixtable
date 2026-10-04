// Released archive fixtures are never rewritten (docs/decisions/archive-format.md).
// On a pull request, fails when a file under tests/fixtures/archives/format-*/
// that exists on the base branch was modified or deleted. New format directories
// and new files are allowed. No-op without a base branch (e.g. push to main).
// Usage: node scripts/ci/check-archive-fixtures.mjs <base-branch>
import { execFileSync } from "node:child_process";

const base = process.argv[2] || process.env.GITHUB_BASE_REF;
if (!base) {
  console.log("not a pull request: archive fixture check skipped");
  process.exit(0);
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const remote = `origin/${base}`;
git("fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/${remote}`);
// A shallow checkout may lack the merge base: deepen until it is found.
for (let depth = 50; ; depth *= 2) {
  try {
    git("merge-base", remote, "HEAD");
    break;
  } catch {
    if (depth > 10_000) {
      git("fetch", "--no-tags", "--unshallow", "origin");
      break;
    }
    git("fetch", "--no-tags", `--deepen=${depth}`, "origin", base);
  }
}
const changed = git(
  "diff",
  "--name-only",
  "--diff-filter=MD",
  `${remote}...HEAD`,
  "--",
  "tests/fixtures/archives",
)
  .split("\n")
  .filter((f) => /^tests\/fixtures\/archives\/format-[^/]+\//.test(f));
if (changed.length > 0) {
  console.error("released archive fixtures were modified or deleted:");
  for (const f of changed) console.error(`  ${f}`);
  console.error("add a new format-<N>/ directory instead (scripts/ci/write-archive-fixtures.mjs)");
  process.exit(1);
}
console.log("archive fixtures unchanged");
