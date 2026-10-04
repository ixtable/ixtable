#!/usr/bin/env node
// Writes web/e2e/service-qa/fixtures/crm.ixt (and crm.roles.json, the roles
// Studio would send to roles-sync): a real archive made from the
// CRM template by the desktop's Rust code (the test bridge), so service-qa
// UI journeys publish the same bytes Studio would upload. Run once after a
// format change: `npm run pretest && node scripts/cloud/make-qa-archive.mjs`.
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const state = mkdtempSync(join(tmpdir(), "ixtable-qa-archive-"));
process.env.IXTABLE_STATE_DIR = state;
// The native test bridge is CommonJS; load it after IXTABLE_STATE_DIR is set.
const { invoke } = createRequire(import.meta.url)(join(root, "src-tauri", "target", "index.cjs"));

(async () => {
  try {
    await invoke("create_from_template", { windowLabel: "main", templateId: "crm" });
    const path = join(state, "crm.ixt");
    await invoke("save_document_as", { windowLabel: "main", path });
    const out = join(root, "web", "e2e", "service-qa", "fixtures", "crm.ixt");
    copyFileSync(path, out);
    const config = await invoke("read_document_config", { windowLabel: "main" });
    const roles = config.roles.map(({ id, name, permissions }) => ({ id, name, permissions }));
    writeFileSync(out.replace(/\.ixt$/, ".roles.json"), `${JSON.stringify(roles, null, 2)}\n`);
    console.log(`wrote ${out} (${statSync(out).size} bytes)`);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
