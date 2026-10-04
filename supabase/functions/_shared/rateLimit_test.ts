// Every Edge Function takes its rate limit from RATE_LIMITS by name, so the
// limits are reviewed in one place (docs/ops/monitoring.md).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { RATE_LIMITS, rateLimitBucket } from "./rateLimit.ts";

// Functions without a per-caller limit: the public probe, the signed
// provider webhook, and the service-role retention job.
const UNLIMITED = new Set(["health", "stripe-webhook", "retention-sweep"]);

function functionSources(): { name: string; source: string }[] {
  const root = new URL("../", import.meta.url);
  const out: { name: string; source: string }[] = [];
  for (const entry of Deno.readDirSync(root)) {
    if (!entry.isDirectory || entry.name.startsWith("_") || entry.name === "node_modules") continue;
    try {
      out.push({
        name: entry.name,
        source: Deno.readTextFileSync(new URL(`${entry.name}/index.ts`, root)),
      });
    } catch {
      // A directory without index.ts is not a function.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("every function's rate limit name exists in RATE_LIMITS", () => {
  const functions = functionSources();
  assert(functions.length > 20, "found the function sources");
  for (const { name, source } of functions) {
    assert(
      !/\benforceRateLimit\(/.test(source),
      `${name}: use enforceNamedRateLimit(name, subject), not ad-hoc numbers`,
    );
    const names = [...source.matchAll(/enforceNamedRateLimit\(\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const used of names) assert(used in RATE_LIMITS, `${name}: unknown limit "${used}"`);
    if (UNLIMITED.has(name)) continue;
    assert(names.includes(name), `${name}: must call enforceNamedRateLimit("${name}", …)`);
  }
});

Deno.test("every RATE_LIMITS entry belongs to a function and has a sane window", () => {
  const names = new Set(functionSources().map((fn) => fn.name));
  for (const [name, limit] of Object.entries(RATE_LIMITS)) {
    assert(names.has(name), `RATE_LIMITS.${name} has no function`);
    assert(limit.max > 0 && limit.windowSeconds >= 60, name);
  }
  assertEquals(rateLimitBucket("key-grant", "u1:a1"), "key-grant:u1:a1");
});
