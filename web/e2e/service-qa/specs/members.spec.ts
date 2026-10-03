/**
 * Contract: members-update (PRD §20.1, §21.3) and the Runtime User's view of
 * the app through RLS: a member reads only their own installations and no
 * audit history.
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
  ensureSingleUserPlan,
  publishOk,
  subscribe,
} from "./distribution-fixtures";

const archives = new ArchiveTracker();
test.afterEach(() => archives.cleanup());

test("role change, revoke and allowance-checked reactivation", async ({ cloud }) => {
  const owner = await cloud.user();
  const alice = await cloud.user();
  const bob = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  archives.add(app.id);
  const clerk = await createRole(app.id, { name: "Clerk" });
  const manager = await createRole(app.id, { name: "Manager" });
  await addMember(app.id, alice.user.id, clerk.id);
  await addMember(app.id, bob.user.id, clerk.id, "revoked");
  await subscribe(app.id, await ensureSingleUserPlan());
  await publishOk(owner, app.id, { version: "1.0.0", expectedHeadVersionId: null });

  const byMember = await call<ErrorBody>("members-update", alice, {
    appId: app.id,
    userId: bob.user.id,
    status: "active",
  });
  const promote = await call<{ member: { role_id: string } }>("members-update", owner, {
    appId: app.id,
    userId: alice.user.id,
    roleId: manager.id,
  });
  const bundle = await call<{ manifest: { roleId: string; roleName: string } }>(
    "bundle-manifest",
    alice,
    { appId: app.id, installationId: randomUUID() },
  );
  const overAllowance = await call<ErrorBody>("members-update", owner, {
    appId: app.id,
    userId: bob.user.id,
    status: "active",
  });
  const revoke = await call<{ member: { status: string } }>("members-update", owner, {
    appId: app.id,
    userId: alice.user.id,
    status: "revoked",
  });
  const afterRevoke = await call<ErrorBody>("bundle-manifest", alice, {
    appId: app.id,
    installationId: randomUUID(),
  });
  const reactivateBob = await call<{ member: { status: string } }>("members-update", owner, {
    appId: app.id,
    userId: bob.user.id,
    status: "active",
  });
  const unknownRole = await call<ErrorBody>("members-update", owner, {
    appId: app.id,
    userId: bob.user.id,
    roleId: randomUUID(),
  });
  const trail = (await auditTrail(app.id))
    .map((row) => row.action)
    .filter((action) => action.startsWith("member."));

  expect(byMember.status).toBe(403);
  expect(promote.body.member.role_id).toBe(manager.id);
  expect(bundle.body.manifest).toMatchObject({ roleId: manager.id, roleName: "Manager" });
  expect(overAllowance.status).toBe(402);
  expect(overAllowance.body.error.details).toMatchObject({ reason: "over_allowance" });
  expect(revoke.body.member.status).toBe("revoked");
  expect(afterRevoke.body.error.code).toBe("REVOKED");
  expect(reactivateBob.body.member.status).toBe("active");
  expect(unknownRole.status).toBe(422);
  expect(trail).toEqual(["member.role_change", "member.revoke", "member.activate"]);

  recordOutcome("members-01-update", {
    expectations: [
      "The owner changes Alice's role and her next bundle manifest carries the new role; a Runtime User cannot update members (403).",
      "Re-activating Bob while the one-user plan is full is 402 over_allowance; after Alice is revoked (her next bundle is 403 REVOKED) Bob's re-activation succeeds.",
      "Audit records member.role_change, member.revoke, member.activate in order.",
    ],
    details: {
      byMember: byMember.body,
      manifestRole: bundle.body.manifest,
      overAllowance: overAllowance.body,
      afterRevoke: afterRevoke.body,
      unknownRole: unknownRole.body,
      trail,
    },
  });
});

test("a Runtime User cannot read other members' installations or the audit trail", async ({
  cloud,
}) => {
  const owner = await cloud.user();
  const alice = await cloud.user();
  const bob = await cloud.user();
  const app = await cloud.app(await cloud.org(owner), owner);
  const role = await createRole(app.id);
  await addMember(app.id, alice.user.id, role.id);
  await addMember(app.id, bob.user.id, role.id);
  await grantSubscription(app.id, "team");
  const aliceInst = await createInstallation(app.id, alice.user.id, "Alice laptop");
  await createInstallation(app.id, bob.user.id, "Bob laptop");
  await call("members-update", owner, {
    appId: app.id,
    userId: bob.user.id,
    roleId: role.id,
    status: "active",
  });
  await call("invitations-create", owner, {
    kind: "app",
    appId: app.id,
    email: "someone@example.com",
    roleId: role.id,
  });

  const aliceInstallations =
    (await alice.client.from("installations").select("id, user_id")).data ?? [];
  const aliceAudit = await alice.client.from("audit_events").select("id").eq("app_id", app.id);
  const aliceMembers =
    (await alice.client.from("app_members").select("user_id").eq("app_id", app.id)).data ?? [];
  const ownerInstallations =
    (await owner.client.from("installations").select("id").eq("app_id", app.id)).data ?? [];
  const ownerAudit =
    (await owner.client.from("audit_events").select("id").eq("app_id", app.id)).data ?? [];
  const serviceAudit = await auditTrail(app.id);

  expect(aliceInstallations).toEqual([{ id: aliceInst, user_id: alice.user.id }]);
  expect(aliceAudit.data ?? []).toEqual([]);
  expect(aliceMembers).toEqual([{ user_id: alice.user.id }]);
  expect(ownerInstallations).toHaveLength(2);
  expect(serviceAudit.length).toBeGreaterThan(0);
  expect(ownerAudit).toHaveLength(serviceAudit.length);
  const { count } = await getServiceClient()
    .from("installations")
    .select("id", { count: "exact", head: true })
    .eq("app_id", app.id);
  expect(count).toBe(2);

  recordOutcome("members-02-rls-scope", {
    expectations: [
      "Through RLS Alice sees only her own installation and her own membership row, not Bob's.",
      "Alice reads no audit events for the app while the owner reads every one the service recorded.",
    ],
    details: {
      aliceInstallations,
      aliceAuditRows: (aliceAudit.data ?? []).length,
      aliceMembers,
      ownerInstallations: ownerInstallations.length,
      ownerAuditRows: ownerAudit.length,
      recorded: serviceAudit.length,
    },
  });
});
