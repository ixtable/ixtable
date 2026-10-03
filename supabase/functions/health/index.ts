// Public liveness probe (no auth): database and storage reachability plus the
// deployed version. Returns 503 when a dependency is down. Never returns
// error details.
import { ARCHIVE_BUCKET, serviceClient } from "../_shared/db.ts";
import { handler, json } from "../_shared/http.ts";

const VERSION = Deno.env.get("IXTABLE_CLOUD_VERSION") ?? "0.1.0";

async function check(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

Deno.serve(
  handler(
    async (req) => {
      const client = serviceClient();
      const [db, storage] = await Promise.all([
        check(async () => !(await client.from("plans").select("id").limit(1)).error),
        check(async () => !(await client.storage.getBucket(ARCHIVE_BUCKET)).error),
      ]);
      const ok = db && storage;
      return json(req, { ok, db, storage, version: VERSION }, ok ? 200 : 503);
    },
    { methods: ["GET", "POST"] },
  ),
);
