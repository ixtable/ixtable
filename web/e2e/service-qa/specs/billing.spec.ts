import { callFunction, getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createRole, createVersion, type TestUser } from "../seed";
import {
  auditActions,
  billingEventRows,
  checkoutAndPay,
  entitlementAs,
  nowSeconds,
  postWebhook,
  stripeEvent,
  subscriptionRow,
} from "./billing-fixtures";
import { credentialWorld, requestGrant, sealSecret, uploadEnvelope } from "./credentials-fixtures";

// Archive objects this file uploads; removed after each test, pass or fail.
const uploaded: string[] = [];
test.afterEach(async () => {
  if (uploaded.length > 0)
    await getServiceClient().storage.from("app-archives").remove(uploaded.splice(0));
});

test("fake checkout completes through the signed webhook and entitles the app", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  const before = await entitlementAs(owner, app.id);

  const { checkout, complete } = await checkoutAndPay(owner, app.id, "team");
  const row = await subscriptionRow(app.id);
  const after = await entitlementAs(owner, app.id);
  const audit = await auditActions({ appId: app.id });

  expect(before).toMatchObject({ allowed: false, reason: "no_subscription" });
  expect(checkout.body.url).toMatch(
    /^http:\/\/127\.0\.0\.1:3001\/cloud\/billing\/fake-checkout\?session=cs_fake_/,
  );
  expect(complete.status).toBe(200);
  expect(row).toMatchObject({
    plan_id: "team",
    status: "active",
    provider: "fake",
    cancel_at_period_end: false,
  });
  expect(row?.stripe_subscription_id).toMatch(/^sub_fake_/);
  expect(row?.current_period_end).not.toBeNull();
  expect(after).toMatchObject({ allowed: true, reason: "ok", allowance: 25, planId: "team" });
  expect(audit.map((event) => event.action)).toEqual(
    expect.arrayContaining(["billing.checkout_started", "billing.subscription_activated"]),
  );

  recordOutcome("billing-01-fake-checkout-activates", {
    expectations: [
      "billing-checkout returns the website's fake checkout URL; completing it posts signed Stripe-shaped events to stripe-webhook.",
      "The webhook writes an active team subscription (fake provider, subscription id, period end).",
      "app_entitlement flips from no_subscription to allowed/ok (allowance 25) and billing.subscription_activated is audited.",
    ],
    details: { before, checkoutUrl: checkout.body.url, complete: complete.body, row, after, audit },
  });
});

test("billing functions are limited to the owner and org owner/admin/billing members", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const billingMember = await cloud.user();
  const plainMember = await cloud.user();
  const stranger = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner);
  const admin = getServiceClient();
  await admin.from("org_members").insert([
    { org_id: org.id, user_id: billingMember.user.id, role: "billing" },
    { org_id: org.id, user_id: plainMember.user.id, role: "member" },
  ]);

  const noCustomerInvoices = await callFunction("billing-invoices", {
    jwt: owner.jwt,
    body: { appId: app.id },
  });
  await checkoutAndPay(billingMember, app.id, "starter");
  const invoices = await callFunction<{ invoices: unknown[] }>("billing-invoices", {
    jwt: billingMember.jwt,
    body: { appId: app.id },
  });
  const portal = await callFunction<{ url: string }>("billing-portal", {
    jwt: owner.jwt,
    body: { appId: app.id },
  });
  const asMember = await callFunction("billing-checkout", {
    jwt: plainMember.jwt,
    body: { appId: app.id, planId: "team" },
  });
  const asStranger = await callFunction("billing-portal", {
    jwt: stranger.jwt,
    body: { appId: app.id },
  });

  expect(noCustomerInvoices).toMatchObject({ status: 200, body: { invoices: [] } });
  expect(invoices.status).toBe(200);
  expect(invoices.body.invoices).toHaveLength(1);
  expect(portal.body.url).toMatch(/\/cloud\/billing\/fake-portal\?app=/);
  expect(asMember.status).toBe(403);
  expect(asMember.body).toEqual({ error: { code: "FORBIDDEN", message: expect.any(String) } });
  expect(asStranger.status).toBe(404);

  recordOutcome("billing-02-authorization", {
    expectations: [
      "An org billing member can check out and list invoices; the owner gets a portal URL; invoices are empty before the first checkout.",
      "A plain org member gets 403 FORBIDDEN from billing-checkout.",
      "A user unrelated to the app gets 404 NOT_FOUND (existence is not revealed).",
    ],
    details: {
      noCustomerInvoices: noCustomerInvoices.body,
      invoices: invoices.body,
      portal: portal.body,
      asMember: { status: asMember.status, body: asMember.body },
      asStranger: { status: asStranger.status, body: asStranger.body },
    },
  });
});

test("a tampered, wrongly signed or expired webhook is rejected with 400 and changes nothing", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");
  const before = await subscriptionRow(app.id);
  const subscriptionId = before?.stripe_subscription_id ?? "";

  const deleted = stripeEvent({
    type: "customer.subscription.deleted",
    appId: app.id,
    planId: "team",
    subscriptionId,
  });
  const tampered = await postWebhook(deleted, {
    tamper: (payload) => payload.replace('"canceled"', '"active"'),
  });
  const wrongSecret = await postWebhook(deleted, { secret: "whsec_attacker" });
  const expired = await postWebhook(deleted, { timestamp: nowSeconds() - 600 });
  const after = await subscriptionRow(app.id);
  const recorded = await billingEventRows(String(deleted.id));

  for (const result of [tampered, wrongSecret, expired]) {
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: { code: "INVALID_SIGNATURE", message: expect.any(String) },
    });
  }
  expect(after).toEqual(before);
  expect(recorded).toEqual([]);

  recordOutcome("billing-03-bad-signature", {
    expectations: [
      "stripe-webhook returns 400 INVALID_SIGNATURE for a body altered after signing, a wrong secret, and a timestamp 10 minutes old.",
      "The subscription row is byte-for-byte unchanged and no billing_events row is written for the rejected event.",
    ],
    details: {
      statuses: [tampered.status, wrongSecret.status, expired.status],
      before,
      after,
      recorded,
    },
  });
});

test("a replayed webhook event is acknowledged without being applied again", async ({ cloud }) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");
  const subscriptionId = (await subscriptionRow(app.id))?.stripe_subscription_id ?? "";
  const t = nowSeconds();

  const upgrade = stripeEvent({
    type: "customer.subscription.updated",
    appId: app.id,
    planId: "business",
    subscriptionId,
    created: t + 1,
  });
  const first = await postWebhook(upgrade);
  const downgrade = stripeEvent({
    type: "customer.subscription.updated",
    appId: app.id,
    planId: "starter",
    subscriptionId,
    created: t + 2,
  });
  await postWebhook(downgrade);
  const replay = await postWebhook(upgrade);
  const row = await subscriptionRow(app.id);
  const recorded = await billingEventRows(String(upgrade.id));
  const planAudits = (await auditActions({ appId: app.id })).filter(
    (event) => event.action === "billing.plan_changed",
  );

  expect(first.body).toEqual({ received: true, outcome: "applied" });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({ received: true, duplicate: true });
  expect(row?.plan_id).toBe("starter");
  expect(recorded).toHaveLength(1);
  expect(planAudits).toHaveLength(2);

  recordOutcome("billing-04-replay-idempotent", {
    expectations: [
      "Replaying an already processed event id returns 200 {received:true, duplicate:true}.",
      "The replay does not reapply the old upgrade: the plan stays on the newer starter downgrade.",
      "billing_events holds exactly one row for the event id; plan_changed is audited once per real change (2).",
    ],
    details: { first: first.body, replay: replay.body, row, recorded, planAudits },
  });
});

test("a deleted subscription denies entitlement and a late older event cannot revive it", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");
  const subscriptionId = (await subscriptionRow(app.id))?.stripe_subscription_id ?? "";
  const t = nowSeconds();

  const deleted = await postWebhook(
    stripeEvent({
      type: "customer.subscription.deleted",
      appId: app.id,
      planId: "team",
      subscriptionId,
      created: t + 30,
    }),
  );
  const late = stripeEvent({
    type: "customer.subscription.updated",
    appId: app.id,
    planId: "team",
    subscriptionId,
    status: "active",
    created: t + 5,
  });
  const lateResult = await postWebhook(late);
  const row = await subscriptionRow(app.id);
  const entitlement = await entitlementAs(owner, app.id);
  const lateRecord = await billingEventRows(String(late.id));

  expect(deleted.body).toEqual({ received: true, outcome: "applied" });
  expect(lateResult.body).toEqual({ received: true, outcome: "stale" });
  expect(row?.status).toBe("canceled");
  expect(entitlement).toMatchObject({ allowed: false, reason: "subscription_inactive" });
  expect(lateRecord[0]).toMatchObject({
    outcome: "stale",
    outcome_reason: "older_than_applied_event",
  });
  expect((await auditActions({ appId: app.id })).map((event) => event.action)).toContain(
    "billing.subscription_canceled",
  );

  recordOutcome("billing-05-deleted-denies", {
    expectations: [
      "customer.subscription.deleted sets the subscription to canceled and app_entitlement to allowed:false, subscription_inactive.",
      "A delayed customer.subscription.updated(active) created before the deletion is recorded as stale and does not revive access.",
      "billing.subscription_canceled is audited.",
    ],
    details: { row, entitlement, lateResult: lateResult.body, lateRecord },
  });
});

test("past_due keeps access during the grace window, then denies it; payment recovers", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");
  const subscriptionId = (await subscriptionRow(app.id))?.stripe_subscription_id ?? "";
  const t = nowSeconds();

  await postWebhook(
    stripeEvent({
      type: "invoice.payment_failed",
      appId: app.id,
      planId: "team",
      subscriptionId,
      created: t + 1,
    }),
  );
  const grace = await entitlementAs(owner, app.id);
  await postWebhook(
    stripeEvent({
      type: "customer.subscription.updated",
      appId: app.id,
      planId: "team",
      subscriptionId,
      status: "past_due",
      currentPeriodEnd: t - 8 * 86_400,
      created: t + 2,
    }),
  );
  const expired = await entitlementAs(owner, app.id);
  await postWebhook(
    stripeEvent({
      type: "invoice.paid",
      appId: app.id,
      planId: "team",
      subscriptionId,
      created: t + 3,
    }),
  );
  const recovered = await entitlementAs(owner, app.id);
  const actions = (await auditActions({ appId: app.id })).map((event) => event.action);

  expect(grace).toMatchObject({ allowed: true, reason: "grace", status: "past_due" });
  expect(expired).toMatchObject({
    allowed: false,
    reason: "subscription_inactive",
    status: "past_due",
  });
  expect(recovered).toMatchObject({ allowed: true, reason: "ok", status: "active" });
  expect(actions).toEqual(
    expect.arrayContaining(["billing.subscription_past_due", "billing.payment_recovered"]),
  );

  recordOutcome("billing-06-past-due-grace", {
    expectations: [
      "invoice.payment_failed moves an active subscription to past_due; entitlement stays allowed with reason grace.",
      "Once the period ended more than 7 days ago, past_due denies entitlement (subscription_inactive).",
      "invoice.paid recovers it to active/ok; past_due and payment_recovered are audited.",
    ],
    details: { grace, expired, recovered, actions },
  });
});

test("a downgrade below the active Runtime Users flips entitlement and the bundle gate", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");
  const version = await createVersion(app, owner.user.id);
  const archivePath = `apps/${app.id}/versions/${version.id}.ixt`;
  await getServiceClient()
    .storage.from("app-archives")
    .upload(archivePath, Buffer.from("ixt"), { contentType: "application/octet-stream" });
  uploaded.push(archivePath);
  const role = await createRole(app.id);
  const members: TestUser[] = [];
  for (let index = 0; index < 6; index += 1) {
    const member = await cloud.user();
    await addMember(app.id, member.user.id, role.id);
    members.push(member);
  }
  const bundle = () =>
    callFunction<{ manifest?: unknown; error?: { code: string; details?: { reason: string } } }>(
      "bundle-manifest",
      {
        jwt: members[0].jwt,
        body: { appId: app.id, installationId: crypto.randomUUID(), deviceName: "QA" },
      },
    );
  const onTeam = await entitlementAs(owner, app.id);
  const bundleOnTeam = await bundle();

  const { checkout } = await checkoutAndPay(owner, app.id, "starter");
  const onStarter = await entitlementAs(owner, app.id);
  const bundleOnStarter = await bundle();
  const row = await subscriptionRow(app.id);

  expect(onTeam).toMatchObject({ allowed: true, reason: "ok", used: 6, allowance: 25 });
  expect(bundleOnTeam.status).toBe(200);
  expect(checkout.body.overAllowance).toBe(true);
  expect(row).toMatchObject({ plan_id: "starter", status: "active" });
  expect(onStarter).toMatchObject({
    allowed: false,
    reason: "over_allowance",
    used: 6,
    allowance: 5,
  });
  expect(bundleOnStarter.status).toBe(402);
  expect(bundleOnStarter.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "over_allowance" },
  });

  recordOutcome("billing-07-downgrade-over-allowance", {
    expectations: [
      "With 6 active Runtime Users the team plan is entitled (used 6 of 25) and a member gets a signed bundle (200).",
      "billing-checkout for starter warns overAllowance:true; after the new checkout the subscription is starter and active.",
      "app_entitlement reports over_allowance (6 of 5) and bundle-manifest refuses the same member with 402 ENTITLEMENT_REQUIRED.",
    ],
    details: {
      onTeam,
      bundleOnTeam: bundleOnTeam.status,
      checkout: checkout.body,
      row,
      onStarter,
      bundleOnStarter: { status: bundleOnStarter.status, error: bundleOnStarter.body.error },
    },
  });
});

test("billing-cancel schedules cancellation at period end and keeps access until then", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  await checkoutAndPay(owner, app.id, "team");

  const result = await callFunction<{ subscription: Record<string, unknown> }>("billing-cancel", {
    jwt: owner.jwt,
    body: { appId: app.id, atPeriodEnd: true },
  });
  const entitlement = await entitlementAs(owner, app.id);
  const actions = (await auditActions({ appId: app.id })).map((event) => event.action);

  expect(result.status).toBe(200);
  expect(result.body.subscription).toMatchObject({
    status: "active",
    cancel_at_period_end: true,
    plan_id: "team",
  });
  expect(result.body.subscription).not.toHaveProperty("stripe_subscription_id");
  expect(entitlement).toMatchObject({ allowed: true, reason: "ok" });
  expect(actions).toEqual(
    expect.arrayContaining(["billing.cancel_requested", "billing.cancel_scheduled"]),
  );

  recordOutcome("billing-08-cancel-at-period-end", {
    expectations: [
      "billing-cancel {atPeriodEnd:true} returns the subscription with cancel_at_period_end:true and no provider ids.",
      "The app stays entitled until the period ends; cancel_requested (actor) and cancel_scheduled (webhook) are audited.",
    ],
    details: { result: result.body, entitlement, actions },
  });
});

test("key-grant follows the subscription: refused without, granted when active, refused after deletion", async ({
  cloud,
}) => {
  const { owner, member, app, installationId } = await credentialWorld(cloud, { subscribe: false });
  const unpaid = await requestGrant(member, app.id, installationId);

  await checkoutAndPay(owner, app.id, "team");
  const upload = await uploadEnvelope(owner, app.id, sealSecret({ password: "pw" }));
  const paid = await requestGrant(member, app.id, installationId);

  const subscriptionId = (await subscriptionRow(app.id))?.stripe_subscription_id ?? "";
  await postWebhook(
    stripeEvent({
      type: "customer.subscription.deleted",
      appId: app.id,
      planId: "team",
      subscriptionId,
      created: nowSeconds() + 5,
    }),
  );
  const canceled = await requestGrant(member, app.id, installationId);

  expect(unpaid.status).toBe(402);
  expect(unpaid.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "no_subscription" },
  });
  expect(upload.status).toBe(200);
  expect(paid.status).toBe(200);
  expect(canceled.status).toBe(402);
  expect(canceled.body.error).toMatchObject({
    code: "ENTITLEMENT_REQUIRED",
    details: { reason: "subscription_inactive" },
  });

  recordOutcome("billing-09-key-grant-gate", {
    expectations: [
      "Without a subscription key-grant answers 402 ENTITLEMENT_REQUIRED (no_subscription).",
      "After the fake checkout's signed webhook activates the plan, the same Runtime User gets a key grant (200).",
      "After customer.subscription.deleted, key-grant answers 402 ENTITLEMENT_REQUIRED (subscription_inactive).",
    ],
    details: {
      unpaid: { status: unpaid.status, error: unpaid.body.error },
      paid: { status: paid.status, grantId: paid.body.grantId },
      canceled: { status: canceled.status, error: canceled.body.error },
    },
  });
});
