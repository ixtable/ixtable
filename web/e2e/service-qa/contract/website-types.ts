/**
 * Compile-time contract check for the website (`npm run typecheck`): every
 * Edge Function reply recorded from the local stack
 * (../fixtures/contract/*.json, see ../contract.ts) must be assignable to the
 * output type the website declares in src/lib/cloud/types.ts FunctionMap.
 * A renamed or missing field, or a field of another JSON type, fails tsc.
 * Literal unions are widened to their base type because JSON imports infer
 * `string`, not `"published"`. Nothing here runs.
 */
import type { FunctionMap, FunctionName } from "@site/src/lib/cloud/types";
import appsCreate from "../fixtures/contract/apps-create.json";
import appsDelete from "../fixtures/contract/apps-delete.json";
import appsDeleteRefused from "../fixtures/contract/apps-delete.403.json";
import billingCancel from "../fixtures/contract/billing-cancel.json";
import billingCheckout from "../fixtures/contract/billing-checkout.json";
import billingFakeComplete from "../fixtures/contract/billing-fake-complete.json";
import billingInvoices from "../fixtures/contract/billing-invoices.json";
import billingPortal from "../fixtures/contract/billing-portal.json";
import credentialDelete from "../fixtures/contract/credential-delete.json";
import desktopAuthApprove from "../fixtures/contract/desktop-auth-approve.json";
import devicesRevoke from "../fixtures/contract/devices-revoke.json";
import invitationsAccept from "../fixtures/contract/invitations-accept.json";
import invitationsCreateApp from "../fixtures/contract/invitations-create.app.json";
import invitationsCreateOrg from "../fixtures/contract/invitations-create.org.json";
import membersUpdate from "../fixtures/contract/members-update.json";
import publishCheckpoint from "../fixtures/contract/publish-checkpoint.json";
import restoreBackup from "../fixtures/contract/restore-url.backup.json";
import restoreVersion from "../fixtures/contract/restore-url.version.json";
import fork from "../fixtures/contract/versions-resolve.fork.json";
import withdraw from "../fixtures/contract/versions-resolve.withdraw.json";
import withdrawRefused from "../fixtures/contract/versions-resolve.withdraw.422.json";
import withdrawConfirmed from "../fixtures/contract/versions-resolve.withdraw.confirmed.json";

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null | undefined
        ? T
        : T extends readonly (infer U)[]
          ? Widen<U>[]
          : T extends object
            ? { [K in keyof T]: Widen<T[K]> }
            : T;

type Out<K extends FunctionName> = Widen<FunctionMap[K]["out"]>;
type ErrorReply<D> = { error: { code: string; message: string; details: D } };
type Version = Widen<NonNullable<FunctionMap["versions-resolve"]["out"]["version"]>>;

// Each line fails to compile when the website's type drifts from the server.
export const websiteContract: unknown[] = [
  appsCreate.response satisfies Out<"apps-create">,
  appsDelete.response satisfies Out<"apps-delete">,
  appsDeleteRefused.response satisfies ErrorReply<{
    reason: string;
    subscriptionStatus: string;
  }>,
  billingCancel.response satisfies Out<"billing-cancel">,
  billingCheckout.response satisfies Out<"billing-checkout">,
  billingFakeComplete.response satisfies Out<"billing-fake-complete">,
  billingInvoices.response satisfies Out<"billing-invoices">,
  billingPortal.response satisfies Out<"billing-portal">,
  credentialDelete.response satisfies Out<"credential-delete">,
  desktopAuthApprove.response satisfies Out<"desktop-auth-approve">,
  devicesRevoke.response satisfies Out<"devices-revoke">,
  invitationsAccept.response satisfies Out<"invitations-accept">,
  invitationsCreateApp.response satisfies Out<"invitations-create">,
  invitationsCreateOrg.response satisfies Out<"invitations-create">,
  membersUpdate.response satisfies Out<"members-update">,
  // A published version row, including the camelCase security summary.
  publishCheckpoint.response.version satisfies Version,
  restoreVersion.response satisfies Out<"restore-url">,
  restoreBackup.response satisfies Out<"restore-url">,
  fork.response satisfies Out<"versions-resolve">,
  fork.response.version satisfies Version,
  withdraw.response satisfies Out<"versions-resolve">,
  withdrawConfirmed.response satisfies Out<"versions-resolve">,
  withdrawRefused.response satisfies ErrorReply<{
    requiresConfirm: boolean;
    installations: number;
  }>,
];
