import { callFunction, getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";

// account-export allows 5 calls per user per hour (RATE_LIMITS in
// supabase/functions/_shared/rateLimit.ts).
const EXPORT_LIMIT = 5;

test("a sensitive endpoint answers 429 RATE_LIMITED once the caller exhausts its window", async ({
  cloud,
}) => {
  const user = await cloud.user();
  const other = await cloud.user();
  const statuses: number[] = [];
  for (let index = 0; index < EXPORT_LIMIT; index += 1) {
    statuses.push((await callFunction("account-export", { jwt: user.jwt, body: {} })).status);
  }
  const limited = await callFunction("account-export", { jwt: user.jwt, body: {} });
  const otherUser = await callFunction("account-export", { jwt: other.jwt, body: {} });
  const { data: bucket } = await getServiceClient()
    .from("rate_limits")
    .select("bucket, count")
    .eq("bucket", `account-export:${user.user.id}`)
    .single();

  expect(statuses).toEqual(Array(EXPORT_LIMIT).fill(200));
  expect(limited.status).toBe(429);
  expect(limited.body).toEqual({
    error: {
      code: "RATE_LIMITED",
      message: expect.any(String),
      details: { retryAfterSeconds: 3600 },
    },
  });
  expect(otherUser.status).toBe(200);
  expect(bucket).toEqual({ bucket: `account-export:${user.user.id}`, count: EXPORT_LIMIT + 1 });

  recordOutcome("ratelimit-01-account-export", {
    expectations: [
      "The first 5 account-export calls in an hour succeed; the 6th returns 429 RATE_LIMITED with retryAfterSeconds.",
      "The limit is per caller: another user's export still succeeds.",
      "rate_limits holds the bucket account-export:<userId> with count 6.",
    ],
    details: {
      statuses,
      limited: { status: limited.status, body: limited.body },
      otherUser: otherUser.status,
      bucket,
    },
  });
});
