import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cargoDependencies,
  committedPrivateKeys,
  GATES,
  runGates,
  unreviewedCrypto,
} from "../../scripts/ci/release-gates.mjs";

const root = join(__dirname, "../..");

describe("release gates", () => {
  it("passes every automated gate on this tree and leaves human sign-offs pending", () => {
    const results = runGates(root);
    expect(results.filter((r: { status: string }) => r.status === "fail")).toEqual([]);
    const pending = results.filter((r: { status: string }) => r.status === "pending");
    expect(pending.map((r: { id: string }) => r.id)).toEqual(
      expect.arrayContaining(["external-security-review", "key-ceremony", "green-ci-all-os"]),
    );
  });

  it("maps every gate in docs/release-checklist.md, and nothing else", () => {
    const doc = readFileSync(join(root, "docs/release-checklist.md"), "utf8");
    const documented = [...doc.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(GATES.map((g: { id: string }) => g.id).sort());
  });

  it("reports a failing check and a check that throws as failures", () => {
    const results = runGates(root, [
      { id: "a", prd: "x", title: "a", check: () => ["broken"] },
      {
        id: "b",
        prd: "x",
        title: "b",
        check: () => {
          throw new Error("boom");
        },
      },
    ]);
    expect(results.map((r: { status: string; detail: string }) => [r.status, r.detail])).toEqual([
      ["fail", "broken"],
      ["fail", "boom"],
    ]);
  });

  it("flags crypto dependencies that are not on the allowlist", () => {
    const toml = `[package]\nname = "x"\n[dependencies]\nsha2 = "0.10"\nmy-aes = "1"\nserde = "1"\n[dev-dependencies]\nring = "0.17"\n[profile.dev]\ndebug = 1\n`;
    expect(cargoDependencies(toml)).toEqual(["sha2", "my-aes", "serde", "ring"]);
    expect(
      unreviewedCrypto(toml, {
        dependencies: { react: "1", "crypto-js": "4" },
        devDependencies: {},
      }),
    ).toEqual(["my-aes", "ring", "crypto-js"]);
  });

  it("finds committed private keys by name or content", () => {
    const files: Record<string, string> = {
      "a.txt": "hello",
      "b.pem": `-----BEGIN ${"PRIVATE"} KEY-----\nMC4CAQ==\n-----END PRIVATE KEY-----`,
      "release/updater.key": "x",
      "c.txt": "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5Cg==",
      "cert.p12": "",
    };
    expect(committedPrivateKeys(Object.keys(files), (f: string) => files[f])).toEqual([
      "b.pem",
      "release/updater.key",
      "c.txt",
      "cert.p12",
    ]);
  });
});
