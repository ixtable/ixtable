# PRD: Billing, Entitlements & Commercial Operations

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Make ixtable Cloud a self-service paid product whose billing state, application entitlements, quotas, cancellation, deletion, and support flows are consistent under retries/failures.

## Commercial model

MVP plans are per cloud application and include a runtime-user allowance.

The billing provider is the source of payment/subscription events; ixtable maintains an internal entitlement projection used by product services.

## Required flows

- checkout;
- subscription activation;
- plan change;
- invoice visibility;
- payment failure handling;
- cancellation;
- runtime-user quota enforcement;
- application entitlement checks;
- export;
- account/application deletion;
- support/recovery tooling.

## Consistency

- Webhook/event processing is idempotent.
- Duplicate/out-of-order events do not create duplicate entitlements.
- Temporary provider outage does not permanently corrupt access state.
- Entitlement state has an auditable reason/source.
- Product access changes follow documented grace periods rather than ad hoc checks.

## Enforcement

Entitlements are checked server-side for:

- cloud application creation where plan-limited;
- publish;
- invited/runtime user count;
- bundle/update delivery;
- backup/retention features;
- other paid cloud capabilities.

The open-source local desktop remains usable without an active cloud subscription.

## Cancellation and deletion

- Cancellation behavior clearly states end-of-term/grace behavior.
- Export precedes destructive deletion where requested.
- Deletion workflows cover cloud archives, user/application metadata, grants, and retained billing records according to legal/accounting requirements.

## Support operations

Operators can diagnose:

- auth;
- publish;
- entitlement;
- storage;
- update;
- key-grant failures

without reading user datasource secrets.

## Acceptance criteria

- New customer can register, pay, publish, invite, run, update, restore, and cancel without operator action.
- Duplicate billing events are safe.
- Runtime-user quota cannot be bypassed by concurrent invitations.
- Local free product continues to function after cloud cancellation.
- Support tooling exposes state transitions without secrets.

## Non-goals

- DRM of the Apache desktop core;
- bespoke enterprise contracts/workflows in MVP;
- usage-based metering beyond defined plan allowances unless separately specified.
