# Support runbook

How support diagnoses distribution, key-grant and billing problems without
seeing secrets (PRD Phase 5 exit criterion).

## Access

Operators have `profiles.is_operator = true` (set by an admin with the
service role; record who and why). Operators get no extra database rights:
they call `admin-support` from the website (Admin → Support) or with their
own session:

```
POST /functions/v1/admin-support
Authorization: Bearer <operator session>
{"query": {"email": "user@example.com"}}   or   {"query": {"appId": "<uuid>"}}
```

The response is assembled from explicit fields only. It never contains
DEKs, envelope ciphertext, nonces, wrapped keys, invitation token hashes,
IP hashes, Stripe ids or session tokens; secret-looking keys in audit
details show as `"[redacted]"`. Every lookup is audited as `admin.lookup`
and the app owner sees it in their audit history. Do not ask customers for
passwords, tokens, `.ixt` files with credentials or database passwords.

## What the diagnostics contain

| Field | Meaning |
|---|---|
| `user.exists`, `confirmed`, `lastSignInAt`, `providers`, `bannedUntil` | can the person sign in at all |
| `orgMemberships`, `appMemberships[].status`, `roleName` | do they belong to the app, and with which role |
| `installations[].revoked`, `lastSeenAt`, `installedVersionId` | which device, revoked or not, which version it runs |
| `recentKeyGrants[]` | grant history (`expired`, `revoked`), no key material |
| `events.lastBundleGenerate`, `events.lastKeyIssue`, `events.recentFailures` | last successful bundle and key issue, recent denials |
| `apps[].entitlement` | `{allowed, reason, allowance, used}` from `app_entitlement` |
| `apps[].subscription`, `recentWebhooks` | plan, status, period end, cancel flag, last webhook outcomes |
| `apps[].latestPublished` | newest published version |
| `apps[].credentialStatus` | which datasources have a credential envelope (shared or per user), revoked or not |
| `metrics` | last 7 days of key, bundle, billing and auth counters |

## Distribution failures ("I can't install / update the app")

1. Look up the user by email.
2. `user.exists` false → they signed up with a different email or never
   accepted the invitation. Ask the owner to re-invite the right address.
3. No `appMemberships` entry for the app → not invited or invitation not
   accepted. `status: revoked` → the owner revoked them; only the owner can
   restore access (members-update).
4. `apps[].entitlement.allowed` false:
   - `no_subscription` / `subscription_inactive` → the owner must subscribe
     or fix payment (billing tab). `past_due` with reason `grace` still
     works; after 7 days past the period end it stops.
   - `over_allowance` → more active Runtime Users than the plan allows
     (often after a downgrade). The owner revokes users or upgrades.
   - `app_deleted` → the app was deleted.
5. `latestPublished` null → the developer has not published a version.
6. The installation is `revoked` → the owner revoked that device; the user
   must install again after the owner allows it.
7. `events.lastBundleGenerate` is recent but the desktop still fails → a
   client-side verification failure (signature, expiry, hash). Ask for the
   desktop diagnostic log (no secrets in it) and the desktop version; check
   `minRuntimeVersion` against it.

## Key-grant failures ("the app can't connect to the database")

1. Look up by email, then by appId.
2. `credentialStatus` has no row for the datasource, or it is `revoked` →
   the owner must upload credentials again from Studio (Cloud tab).
   Per-user mode needs a row with that user's id.
3. Membership revoked, installation revoked or entitlement denied → same as
   distribution steps 3, 4 and 6; key grants follow the same rules.
4. `recentKeyGrants` shows grants but the user still fails → the grant
   expired and renewal failed. Check `events.recentFailures` and
   `metrics` (rate limiting shows as `RATE_LIMITED` in the desktop log; it
   clears after the window).
5. Grants fail for many apps at once → escalate as an incident
   (`incidents.md` → "Key grants failing").
6. The database itself refuses the connection → credentials are wrong or
   rotated at the customer's database. Only the owner can fix this; we
   never see the password.

## Billing problems

1. Look up by appId. Compare `subscription.status` with the Stripe
   dashboard (search by the customer's email in Stripe, not in our DB).
2. `recentWebhooks` with `failed` or a missing recent event → follow
   `incidents.md` → "Billing webhook failing"; resending the Stripe event is
   always safe.
3. A plan change shows `over_allowance` → expected after a downgrade below
   the active users; explain the options.
4. Refunds and invoice corrections happen in Stripe only.

## Account export and deletion requests

- Users export their own data on the website (Account → Export), which
  calls `account-export` (JSON plus 1-hour archive links). Support never
  exports on someone's behalf.
- Deletion: `account-delete` refuses while the user owns apps with active
  subscriptions (unless they confirm cancellation) or is the only owner of
  an organization with other members (transfer ownership first). Explain
  which; do not delete accounts manually.
