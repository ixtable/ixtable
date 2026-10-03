import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { HttpError } from "./http.ts";
import { confirmationsOff, isProduction, requireEmailConfirmations } from "./production.ts";

const settings =
  (body: unknown, ok = true): typeof fetch =>
  () =>
    Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 503 }));

Deno.test("confirmations count as off unless Auth says mailer_autoconfirm false", () => {
  assertEquals(confirmationsOff({ mailer_autoconfirm: false }), false);
  assertEquals(confirmationsOff({ mailer_autoconfirm: true }), true);
  assertEquals(confirmationsOff(null), true);
  assertEquals(isProduction({ IXTABLE_ENV: "production" }), true);
  assertEquals(isProduction({}), false);
});

Deno.test("invitations-accept guard refuses in production while confirmations are off", async () => {
  const prod = { IXTABLE_ENV: "production", SUPABASE_URL: "http://auth.test" };
  // Local stacks (no IXTABLE_ENV) never call Auth.
  await requireEmailConfirmations({}, () => Promise.reject(new Error("not called")));
  for (const fetcher of [
    settings({ mailer_autoconfirm: true }),
    settings({}, false),
    () => Promise.reject(new TypeError("offline")),
  ]) {
    const error = await assertRejects(() => requireEmailConfirmations(prod, fetcher), HttpError);
    assertEquals([error.code, error.details?.reason], ["INTERNAL", "email_confirmations_disabled"]);
  }
  await requireEmailConfirmations(prod, settings({ mailer_autoconfirm: false }));
});
