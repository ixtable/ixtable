import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  configuredPubkey,
  DEV_CLOUD_KEYS,
  devCloudKeys,
  embeddedKeyProblems,
  isDevUpdaterKey,
  probeUpdaterKeyPair,
  rawCloudKey,
  releaseCloudKey,
  releaseKeyProblems,
  releaseUpdaterPubkey,
  tauriCli,
} from "../../scripts/release/keys.mjs";
import { tauriConfigOverride } from "../../scripts/release/signing.mjs";

const root = join(__dirname, "../..");
const devPubkey = configuredPubkey(root);
const scratch = mkdtempSync(join(tmpdir(), "ixtable-keys-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function cloudKey() {
  const spki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return { spki: spki.toString("base64"), raw: spki.subarray(12).toString("base64") };
}

function minisignPubkey() {
  const spki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const body = Buffer.concat([Buffer.from("Ed"), randomBytes(8), spki.subarray(12)]);
  const file = `untrusted comment: minisign public key: test\n${body.toString("base64")}\n`;
  return Buffer.from(file).toString("base64");
}

const production = () => ({
  IXTABLE_UPDATER_PUBKEY: minisignPubkey(),
  IXTABLE_CLOUD_PUBLIC_KEY_RAW: cloudKey().raw,
});

describe("release key gate", () => {
  it("accepts production keys from variables", () => {
    expect(releaseKeyProblems(production(), root)).toEqual([]);
    expect(releaseKeyProblems({ ...production(), IXTABLE_CLOUD_PUBLIC_KEY_RAW: "" }, root)).toEqual(
      [expect.stringMatching(/IXTABLE_CLOUD_PUBLIC_KEY_RAW is not set/)],
    );
    const spkiOnly = {
      IXTABLE_UPDATER_PUBKEY: minisignPubkey(),
      IXTABLE_CLOUD_PUBLIC_KEY: cloudKey().spki,
    };
    expect(releaseKeyProblems(spkiOnly, root)).toEqual([]);
  });

  it("refuses missing keys", () => {
    expect(releaseKeyProblems({}, root)).toEqual([
      expect.stringMatching(/IXTABLE_UPDATER_PUBKEY is not set/),
      expect.stringMatching(/IXTABLE_CLOUD_PUBLIC_KEY_RAW is not set/),
    ]);
    expect(releaseKeyProblems({ IXTABLE_UPDATER_PUBKEY: "  " }, root)[0]).toMatch(/not set/);
  });

  it("refuses the committed updater key, however it is spelled", () => {
    const env = { ...production(), IXTABLE_UPDATER_PUBKEY: ` ${devPubkey}\n` };
    expect(releaseKeyProblems(env, root)).toEqual([
      "IXTABLE_UPDATER_PUBKEY is the committed development key",
    ]);
    expect(isDevUpdaterKey(devPubkey, root)).toBe(true);
    expect(isDevUpdaterKey(minisignPubkey(), root)).toBe(false);
  });

  it("refuses dev and test cloud keys in every accepted encoding", () => {
    const rfc8032 = Buffer.from(DEV_CLOUD_KEYS[0], "hex");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rfc8032]);
    for (const value of [DEV_CLOUD_KEYS[0], rfc8032.toString("base64"), spki.toString("base64")])
      expect(
        releaseKeyProblems({ ...production(), IXTABLE_CLOUD_PUBLIC_KEY_RAW: value }, root),
      ).toEqual(["IXTABLE_CLOUD_PUBLIC_KEY_RAW is a development or test key"]);
  });

  it("treats this checkout's local Supabase key as a dev key", () => {
    const local = cloudKey();
    mkdirSync(join(scratch, "supabase/functions"), { recursive: true });
    writeFileSync(
      join(scratch, "supabase/functions/.env.local"),
      `IXTABLE_CLOUD_PUBLIC_KEY=${local.spki}\nIXTABLE_CLOUD_PUBLIC_KEY_RAW=${local.raw}\n`,
    );
    expect(devCloudKeys(scratch).has(rawCloudKey(local.raw).toString("hex"))).toBe(true);
    expect(devCloudKeys(root).has("0".repeat(64))).toBe(true);
  });

  it("refuses malformed keys", () => {
    const problems = releaseKeyProblems(
      { IXTABLE_UPDATER_PUBKEY: "bm90IGEga2V5", IXTABLE_CLOUD_PUBLIC_KEY_RAW: "abc" },
      root,
    );
    expect(problems).toEqual([
      "IXTABLE_UPDATER_PUBKEY: Malformed minisign public key",
      "IXTABLE_CLOUD_PUBLIC_KEY_RAW: not a valid Ed25519 public key",
    ]);
  });

  it("verifies against the variable when set, else the committed key", () => {
    const pubkey = minisignPubkey();
    expect(releaseUpdaterPubkey({ IXTABLE_UPDATER_PUBKEY: pubkey }, root)).toBe(pubkey);
    expect(releaseUpdaterPubkey({}, root)).toBe(devPubkey);
    expect(
      releaseCloudKey({ IXTABLE_CLOUD_PUBLIC_KEY: "b", IXTABLE_CLOUD_PUBLIC_KEY_RAW: "a" }),
    ).toBe("a");
  });

  it("puts the production updater key into the tauri --config override", () => {
    const pubkey = minisignPubkey();
    expect(tauriConfigOverride("linux", { IXTABLE_UPDATER_PUBKEY: pubkey }).plugins).toEqual({
      updater: { pubkey },
    });
    expect(tauriConfigOverride("linux", {}).plugins).toBeUndefined();
  });

  it("checks what a built binary pins", () => {
    const env = production();
    const good = Buffer.concat([randomBytes(64), Buffer.from(env.IXTABLE_CLOUD_PUBLIC_KEY_RAW)]);
    expect(embeddedKeyProblems(good, env, root)).toEqual([]);
    expect(embeddedKeyProblems(randomBytes(64), env, root)).toEqual([
      "the binary does not pin the release ixtable Cloud key",
    ]);
    const dev = Buffer.concat([good, Buffer.from(devPubkey)]);
    expect(embeddedKeyProblems(dev, env, root)).toEqual([
      "the binary embeds the committed development updater key",
    ]);
  });
});

describe("updater key pair probe", () => {
  it("passes for a matching pair and fails for another key", { timeout: 60_000 }, async () => {
    const key = join(scratch, "probe.key");
    const made = spawnSync(
      process.execPath,
      [tauriCli(root), "signer", "generate", "--ci", "-p", "", "-w", key],
      { cwd: root, encoding: "utf8" },
    );
    expect(made.status, made.stderr).toBe(0);
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, "utf8") };
    await expect(
      probeUpdaterKeyPair(env, readFileSync(`${key}.pub`, "utf8"), root),
    ).resolves.toBeUndefined();
    await expect(probeUpdaterKeyPair(env, devPubkey, root)).rejects.toThrow(/different key/);
  });
});

describe("manifest publishing", () => {
  it("refuses to publish against the development key", () => {
    const run = spawnSync(
      process.execPath,
      [join(root, "scripts/release/update-manifest.mjs"), "prepare", "--channel", "stable"],
      { encoding: "utf8", env: { ...process.env, IXTABLE_UPDATER_PUBKEY: "" } },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/development key; refusing to publish/);
  });
});
