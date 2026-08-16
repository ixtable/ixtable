import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { screenshots } from "./manifest.mjs";

const root = resolve(import.meta.dirname, "../..");
const generated = resolve(import.meta.dirname, ".generated");
const destination = resolve(root, "web/docs/assets");
mkdirSync(generated, { recursive: true });
mkdirSync(destination, { recursive: true });

for (const sourceName of Object.keys(screenshots)) {
  const stem = sourceName.replace(/\.png$/, "");
  for (const extension of ["png", "json", "html"]) {
    const file = resolve(generated, `${stem}.${extension}`);
    if (existsSync(file)) rmSync(file);
  }
}
for (const destinationName of Object.values(screenshots)) {
  const file = resolve(destination, destinationName);
  if (existsSync(file)) rmSync(file);
}

const run = { id: randomUUID(), startedAt: new Date().toISOString() };
writeFileSync(resolve(generated, "capture-run.json"), JSON.stringify(run, null, 2));
console.log(
  `Started fresh screenshot run ${run.id}; removed previous generated and documentation images.`,
);
