/**
 * Per-test cloud fixture with guaranteed teardown. Use the Playwright
 * fixture (`import { test } from "../fixture"`) and call `cloud.user()`,
 * `cloud.org()`, `cloud.app()`. Everything created is removed after the test,
 * pass or fail: apps (cascading versions, members, envelopes, grants,
 * subscriptions), then orgs, then users. Audit rows stay (append-only).
 */
import { test as base, expect } from "@playwright/test";
import { getServiceClient } from "./clients";
import {
  type AppRow,
  createApp,
  createOrg,
  createTestUser,
  deleteTestUser,
  type OrgRow,
  type TestUser,
} from "./seed";

export class CloudFixture {
  readonly admin = getServiceClient();
  private readonly users: TestUser[] = [];
  private readonly orgs: OrgRow[] = [];
  private readonly apps: AppRow[] = [];

  async user(opts: { email?: string; password?: string } = {}): Promise<TestUser> {
    const user = await createTestUser(opts);
    this.users.push(user);
    return user;
  }

  async org(owner: TestUser, name?: string): Promise<OrgRow> {
    const org = await createOrg(owner, name);
    this.orgs.push(org);
    return org;
  }

  async app(
    org: OrgRow,
    owner: TestUser,
    opts: Parameters<typeof createApp>[2] = {},
  ): Promise<AppRow> {
    const app = await createApp(org, owner, opts);
    this.apps.push(app);
    return app;
  }

  /** Track rows created by the contract under test (e.g. an app made by apps-create). */
  trackApp(app: AppRow): void {
    this.apps.push(app);
  }

  trackOrg(org: OrgRow): void {
    this.orgs.push(org);
  }

  async teardown(): Promise<void> {
    const errors: string[] = [];
    const appIds = this.apps.map((app) => app.id);
    if (appIds.length > 0) {
      const { error } = await this.admin.from("cloud_apps").delete().in("id", appIds);
      if (error) errors.push(`apps: ${error.message}`);
    }
    // Apps created by functions under test inside tracked orgs.
    const orgIds = this.orgs.map((org) => org.id);
    if (orgIds.length > 0) {
      await this.admin.from("cloud_apps").delete().in("org_id", orgIds);
      const { error } = await this.admin.from("organizations").delete().in("id", orgIds);
      if (error) errors.push(`orgs: ${error.message}`);
    }
    for (const user of this.users) {
      await user.client.auth.signOut().catch(() => undefined);
      // Apps the user owns elsewhere would block deletion (owner_id is RESTRICT).
      await this.admin.from("cloud_apps").delete().eq("owner_id", user.user.id);
      try {
        await deleteTestUser(user.user.id, this.admin);
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (errors.length > 0) throw new Error(`CloudFixture teardown: ${errors.join("; ")}`);
  }
}

/** Run `fn` with a fixture outside the Playwright fixture system; always tears down. */
export async function withCloudFixture<T>(fn: (cloud: CloudFixture) => Promise<T>): Promise<T> {
  const cloud = new CloudFixture();
  try {
    return await fn(cloud);
  } finally {
    await cloud.teardown();
  }
}

export const test = base.extend<{ cloud: CloudFixture }>({
  // Playwright reads fixture dependencies from the destructuring pattern.
  // eslint-disable-next-line no-empty-pattern
  cloud: async ({}, use) => {
    const cloud = new CloudFixture();
    try {
      await use(cloud);
    } finally {
      await cloud.teardown();
    }
  },
});

export { expect };
