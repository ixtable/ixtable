/**
 * Contract: apps-create, apps-delete, apps-transfer, roles-sync (PRD §20.1,
 * §25). One Developer/Owner per app; deletion is typed-name confirmed, soft,
 * and cuts off every Runtime User; transfer is explicit and audited; roles
 * mirror the desktop by id.
 */
import { randomUUID } from "node:crypto";
import { getServiceClient } from "../clients";
import { expect, test } from "../fixture";
import { recordOutcome } from "../record";
import { addMember, createInstallation, createRole, grantSubscription } from "../seed";
import {
  ArchiveTracker,
  auditTrail,
  call,
  type ErrorBody,
  publishOk,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

type AppBody = { app: { id: string; owner_id: string; org_id: string; document_id: string } };

test("apps-create: org members create, billing and strangers cannot, one live app per document", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const billing = await cloud.user();
  const stranger = await cloud.user();
  const org = await cloud.org(owner);
  await getServiceClient()
    .from("org_members")
    .insert({ org_id: org.id, user_id: billing.user.id, role: "billing" });
  const documentId = randomUUID();

  const created = await call<AppBody>("apps-create", owner, {
    orgId: org.id,
    name: "  Inventory  ",
    documentId,
  });
  const duplicate = await call<ErrorBody>("apps-create", owner, {
    orgId: org.id,
    name: "Again",
    documentId,
  });
  const byBilling = await call<ErrorBody>("apps-create", billing, {
    orgId: org.id,
    name: "X",
    documentId: randomUUID(),
  });
  const byStranger = await call<ErrorBody>("apps-create", stranger, {
    orgId: org.id,
    name: "X",
    documentId: randomUUID(),
  });
  const invalid = await call<ErrorBody>("apps-create", owner, {
    orgId: "nope",
    name: "X",
    documentId: "d",
  });
  const visible =
    (await owner.client.from("cloud_apps").select("id, name").eq("org_id", org.id)).data ?? [];

  expect(created.status).toBe(200);
  expect(created.body.app).toMatchObject({
    owner_id: owner.user.id,
    org_id: org.id,
    document_id: documentId,
    name: "Inventory",
  });
  expect(duplicate.status).toBe(422);
  expect(duplicate.body.error.details).toMatchObject({ appId: created.body.app.id });
  expect(byBilling.status).toBe(403);
  expect(byStranger.status).toBe(404);
  expect(invalid.status).toBe(422);
  expect(visible).toEqual([{ id: created.body.app.id, name: "Inventory" }]);

  recordOutcome("apps-01-create", {
    expectations: [
      "An org owner creates an app and becomes its owner (name trimmed); the app is visible to them through RLS.",
      "A second app for the same document in the org is 422 naming the existing app id.",
      "A billing-only member gets 403, a non-member 404, and malformed input 422.",
    ],
    details: {
      app: created.body.app,
      duplicate: duplicate.body,
      byBilling: byBilling.body,
      byStranger: byStranger.body,
      invalid: invalid.body,
    },
  });
});

test("apps-delete: typed confirmation, soft delete, every member cut off", async ({ cloud }) => {
  const owner = await cloud.user();
  const member = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner, { name: "Work orders" });
  archives.add(app.id);
  const role = await createRole(app.id);
  await addMember(app.id, member.user.id, role.id);
  await grantSubscription(app.id, "team");
  await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });
  const installationId = await createInstallation(app.id, member.user.id);

  const byMember = await call<ErrorBody>("apps-delete", member, {
    appId: app.id,
    confirm: "Work orders",
  });
  const wrongName = await call<ErrorBody>("apps-delete", owner, {
    appId: app.id,
    confirm: "work order",
  });
  const billed = await call<ErrorBody>("apps-delete", owner, {
    appId: app.id,
    confirm: "Work orders",
  });
  const deleted = await call<{
    deletedAt: string;
    subscriptionStatus: string;
    subscriptionCanceled: boolean;
  }>("apps-delete", owner, { appId: app.id, confirm: "Work orders", cancelSubscription: true });
  const bundle = await call<ErrorBody>("bundle-manifest", member, {
    appId: app.id,
    installationId,
  });
  const again = await call<ErrorBody>("apps-delete", owner, {
    appId: app.id,
    confirm: "Work orders",
  });
  const admin = getServiceClient();
  const { data: row } = await admin
    .from("cloud_apps")
    .select("deleted_at")
    .eq("id", app.id)
    .single();
  const { data: memberRow } = await admin
    .from("app_members")
    .select("status")
    .eq("app_id", app.id)
    .eq("user_id", member.user.id)
    .single();
  const { data: inst } = await admin
    .from("installations")
    .select("revoked_at")
    .eq("id", installationId)
    .single();
  const { data: subscription } = await admin
    .from("subscriptions")
    .select("status")
    .eq("app_id", app.id)
    .single();
  const trail = await auditTrail(app.id);
  const event = trail.find((e) => e.action === "app.delete");
  const canceled = trail.find((e) => e.action === "billing.subscription_canceled");

  expect(byMember.status).toBe(403);
  expect(wrongName.status).toBe(422);
  expect(billed.status).toBe(403);
  expect(billed.body.error.details).toEqual({
    reason: "active_subscription",
    subscriptionStatus: "active",
  });
  expect(deleted.status).toBe(200);
  expect(deleted.body).toMatchObject({
    subscriptionStatus: "canceled",
    subscriptionCanceled: true,
  });
  expect(subscription?.status).toBe("canceled");
  expect(canceled?.details).toMatchObject({ reason: "app_delete", previousStatus: "active" });
  expect(row?.deleted_at).not.toBeNull();
  expect(memberRow?.status).toBe("revoked");
  expect(inst?.revoked_at).not.toBeNull();
  expect(bundle.status).toBe(404);
  expect(again.status).toBe(404);
  expect(event?.details).toMatchObject({
    revokedMembers: 1,
    revokedInstallations: 1,
    subscriptionStatus: "active",
    subscriptionCanceled: true,
  });

  recordOutcome("apps-02-delete", {
    expectations: [
      "A Runtime User cannot delete (403) and a mistyped name is 422; with the exact name the app is soft-deleted (deleted_at set, row kept).",
      "Deletion revokes the member and their installation, and bundle-manifest then returns 404.",
      "app.delete is audited with the revoked counts and subscriptionCanceled true.",
    ],
    details: {
      byMember: byMember.body,
      wrongName: wrongName.body,
      billed: billed.body,
      deleted: deleted.body,
      memberRow,
      installation: inst,
      bundle: bundle.body,
      audit: event?.details,
    },
  });
  recordOutcome("apps-05-delete-cancels-billing", {
    expectations: [
      "While the subscription bills, apps-delete without cancelSubscription is 403 FORBIDDEN with details.reason active_subscription and deletes nothing.",
      "With cancelSubscription:true the subscription row becomes canceled and billing.subscription_canceled is audited with reason app_delete.",
    ],
    details: {
      billed: billed.body,
      deleted: deleted.body,
      subscription,
      canceled: canceled?.details,
    },
  });
});

test("apps-transfer and roles-sync", async ({ cloud }) => {
  const owner = await cloud.user();
  const colleague = await cloud.user();
  const org = await cloud.org(owner);
  const app = await cloud.app(org, owner, { name: "CRM" });
  const keepId = randomUUID();
  const usedId = randomUUID();
  const dropId = randomUUID();
  const sync1 = await call<{ roles: { id: string }[] }>("roles-sync", owner, {
    appId: app.id,
    roles: [
      { id: keepId, name: "Clerk", permissions: { a: 1 } },
      { id: usedId, name: "Viewer", permissions: {} },
      { id: dropId, name: "Temp", permissions: {} },
    ],
  });
  await addMember(app.id, colleague.user.id, usedId);
  const sync2 = await call<{
    roles: { id: string; name: string; permissions: Record<string, unknown> }[];
    kept: string[];
  }>("roles-sync", owner, {
    appId: app.id,
    roles: [{ id: keepId, name: "Clerk II", permissions: { b: 2 } }],
  });
  const byMember = await call<ErrorBody>("roles-sync", colleague, { appId: app.id, roles: [] });

  const notInOrg = await call<ErrorBody>("apps-transfer", owner, {
    appId: app.id,
    newOwnerId: colleague.user.id,
    confirm: "CRM",
  });
  await getServiceClient()
    .from("org_members")
    .insert({ org_id: org.id, user_id: colleague.user.id, role: "member" });
  const transfer = await call<AppBody>("apps-transfer", owner, {
    appId: app.id,
    newOwnerId: colleague.user.id,
    confirm: "CRM",
  });
  const oldOwnerAgain = await call<ErrorBody>("apps-transfer", owner, {
    appId: app.id,
    newOwnerId: owner.user.id,
    confirm: "CRM",
  });
  const { data: membership } = await getServiceClient()
    .from("app_members")
    .select("user_id")
    .eq("app_id", app.id);
  const actions = (await auditTrail(app.id)).map((e) => e.action);

  expect(sync1.body.roles).toHaveLength(3);
  expect(sync2.body.roles.map((r) => r.id).sort()).toEqual([keepId, usedId].sort());
  expect(sync2.body.roles.find((r) => r.id === keepId)).toMatchObject({
    name: "Clerk II",
    permissions: { b: 2 },
  });
  expect(sync2.body.kept).toEqual([usedId]);
  expect(byMember.status).toBe(403);
  expect(notInOrg.status).toBe(422);
  expect(transfer.body.app.owner_id).toBe(colleague.user.id);
  expect(membership).toEqual([]);
  expect(oldOwnerAgain.status).toBe(403);
  expect(actions).toEqual(["role.sync", "role.sync", "app.transfer"]);

  recordOutcome("apps-03-roles-sync", {
    expectations: [
      "roles-sync upserts roles by desktop id (rename and new permissions applied) and deletes absent roles unless a member still uses them (returned in kept).",
      "Only the Developer/Owner may sync roles (a member gets 403).",
    ],
    details: { first: sync1.body.roles.length, second: sync2.body, byMember: byMember.body },
  });
  recordOutcome("apps-04-transfer", {
    expectations: [
      "apps-transfer to someone outside the org is 422; to an org member it makes them the single owner and removes their Runtime User membership.",
      "The previous owner can no longer act as owner (403), and the transfer is audited as app.transfer.",
    ],
    details: {
      notInOrg: notInOrg.body,
      newOwner: transfer.body.app.owner_id,
      membership,
      oldOwnerAgain: oldOwnerAgain.body,
      actions,
    },
  });
});
