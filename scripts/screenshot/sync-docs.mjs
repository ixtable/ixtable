import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { screenshots } from "./manifest.mjs";

const root = resolve(import.meta.dirname, "../..");
const generated = resolve(import.meta.dirname, ".generated");
const destination = resolve(root, "web/docs/assets");
mkdirSync(destination, { recursive: true });

const checkOnly = process.argv.includes("--check");
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const runPath = resolve(generated, "capture-run.json");
if (!existsSync(runPath)) throw new Error("Missing screenshot run marker. Run npm run screenshot.");
const run = JSON.parse(readFileSync(runPath, "utf8"));

for (const [sourceName, destinationName] of Object.entries(screenshots)) {
  const source = resolve(generated, sourceName);
  const target = resolve(destination, destinationName);
  if (!existsSync(source)) {
    throw new Error(`Missing ${sourceName}. Run the screenshot test before syncing docs.`);
  }
  const metadataPath = source.replace(/\.png$/, ".json");
  if (!existsSync(metadataPath))
    throw new Error(`Missing capture metadata for ${sourceName}. Run npm run screenshot.`);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.runId !== run.id)
    throw new Error(
      `Stale generated screenshot: ${sourceName} is not from the current capture run.`,
    );
  if (checkOnly) {
    if (!existsSync(target) || digest(source) !== digest(target)) {
      throw new Error(
        `Stale documentation screenshot: ${destinationName}. Run npm run screenshot:docs.`,
      );
    }
  } else {
    copyFileSync(source, target);
  }
}

console.log(
  checkOnly
    ? `Verified ${Object.keys(screenshots).length} documentation screenshots.`
    : `Copied ${Object.keys(screenshots).length} app screenshots to web/docs/assets.`,
);
