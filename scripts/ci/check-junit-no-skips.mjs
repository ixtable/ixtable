// Fails when a JUnit report records any skipped test or no tests at all, so a
// suite that skips itself (it.skip, skipIf, a missing service) cannot pass CI.
// Usage: node scripts/ci/check-junit-no-skips.mjs <report.xml> <label>
import { readFileSync } from "node:fs";

const [file, label = file] = process.argv.slice(2);
const xml = readFileSync(file, "utf8");
if (/<skipped/.test(xml)) {
  console.error(`${label}: some tests were skipped`);
  process.exit(1);
}
if (!/<testcase\b/.test(xml)) {
  console.error(`${label}: no tests ran`);
  process.exit(1);
}
