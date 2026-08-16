#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const assets = path.join(root, "dist", "assets");
const output = path.join(root, "scripts", "screenshot", ".generated", "app.css");
const cssFiles = fs.readdirSync(assets).filter((file) => file.endsWith(".css"));
if (cssFiles.length === 0) throw new Error("No compiled CSS found. Run npm run build first.");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  cssFiles.map((file) => fs.readFileSync(path.join(assets, file), "utf8")).join("\n"),
);
console.log(`Wrote ${path.relative(root, output)}`);
