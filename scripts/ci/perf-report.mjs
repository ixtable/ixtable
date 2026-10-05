// Prints the performance harness results (reports/perf/*.json) as a Markdown table,
// writes reports/perf/summary.md, and appends it to the GitHub job summary when set.
// Report-only (docs/decisions/performance-budgets.md): a budget miss never fails.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? join("reports", "perf");
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];
const lines = [
  "## Performance budgets (PRD §27.3)",
  "",
  "Report-only. Reference hardware: GitHub `ubuntu-latest` runner. Budgets and fixture: `docs/decisions/performance-budgets.md`.",
  "",
];
for (const file of files) {
  const report = JSON.parse(readFileSync(join(dir, file), "utf8"));
  lines.push(`### ${report.suite} (${file})`, "");
  if (report.fixture) lines.push(`Fixture: ${report.fixture}`, "");
  if (report.environment) lines.push(`Environment: ${report.environment}`, "");
  lines.push("| Target | Budget | Median | p95 | Status |", "|---|---:|---:|---:|---|");
  for (const r of report.results) {
    const budget = r.budgetMs == null ? "–" : `${r.budgetMs} ms`;
    const status = r.budgetMs == null ? "info" : r.p95Ms <= r.budgetMs ? "within" : "**over**";
    lines.push(`| ${r.target} | ${budget} | ${r.medianMs} ms | ${r.p95Ms} ms | ${status} |`);
  }
  lines.push("");
}
if (!files.length) lines.push("No results: the harness did not run.", "");
const markdown = lines.join("\n");
console.log(markdown);
if (existsSync(dir)) writeFileSync(join(dir, "summary.md"), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
