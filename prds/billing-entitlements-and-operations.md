# PRD: Billing, Entitlements & Commercial Operations

**Parent:** [Commercial MVP](./commercial-mvp.md)  
**Status:** MVP implementation contract

## Objective

Make ixtable Cloud self-service while keeping billing events, internal entitlement state, quotas, cancellation, deletion, and support behavior deterministic under retries and partial outages.

## Separation of concerns

The payment provider owns payment/subscription facts.

ixtable owns a normalized internal commercial model used by product services.

Product authorization must not call the payment provider synchronously on every request.

## Core commercial entities

The implementation must model stable IDs for:

- customer/billing account;
- organization;
- cloud application;
- subscription;
- plan/price;
- entitlement;
- quota/usage counter where required;
- provider event;
- commercial state transition.

Provider IDs are references, not the only internal identity.

## Commercial model

MVP pricing is per cloud application and includes a Runtime-user allowance.

The specific plan catalog may change without changing the entitlement architecture.

Entitlements should describe product capabilities/limits such as:

- application paid status;
- allowed Runtime-user count;
- backup/retention allowance;
- publish/distribution eligibility;
- other paid cloud capabilities explicitly added by plan.

## Subscription lifecycle

At minimum normalize these states/events:

- checkout initiated;
- active/paid;
- trialing if offered;
- payment past due;
- grace period;
- canceled at period end;
- canceled/expired;
- refund/chargeback consequences where operationally relevant.

User-facing access behavior for each normalized state must be explicit.

Do not scatter provider-specific status-string checks across product services.

## Event ingestion

Provider webhook/event processing must:

- verify provider authenticity/signature;
- persist provider event ID;
- process idempotently;
- tolerate duplicate delivery;
- tolerate out-of-order delivery;
- maintain enough event/version timestamp information to avoid stale events overwriting newer state;
- retry transient failures;
- dead-letter/escalate permanently unprocessable events;
- expose operational visibility.

Acknowledge provider events only according to a strategy that does not silently lose failed processing.

## Entitlement projection

Internal entitlement state is derived from normalized commercial state.

Every entitlement decision should be explainable by:

- account/application;
- plan;
- source subscription/event;
- effective time;
- expiry/grace time where applicable;
- current limit/value.

Sensitive payment details are not required in product entitlement tables.

## Server-side enforcement

Paid capability checks occur server-side for at least:

- paid cloud application operation;
- publish;
- active/invited Runtime-user quota;
- personalized bundle/update delivery;
- cloud backup/retention;
- credential/key-grant issuance where paid entitlement is required.

Desktop local/free features must not require a cloud entitlement check.

## Quota concurrency

Runtime-user allowances must be enforced transactionally/atomically enough that concurrent invitation/activation requests cannot exceed the plan without a deliberate documented grace policy.

Define whether pending invitations count toward quota. The choice must be consistent across UI/API.

## Payment failure and grace

Temporary payment failure should not create immediate destructive data loss.

The plan must specify:

- grace duration;
- capabilities allowed during grace;
- which new operations become blocked;
- eventual read/export access;
- retention/deletion timeline after expiry.

Grace is a commercial policy represented in state, not an ad hoc timestamp check in each service.

## Cancellation

Cancellation flow shows:

- effective end date;
- future cloud capability loss;
- export options;
- retained/deleted data policy.

Cancellation must not disable the Apache-licensed local desktop or local `.ixt` files.

## Export and deletion

Users can export data/content they are entitled to retrieve before destructive deletion.

Deletion orchestration covers:

- application membership/control-plane metadata;
- developer checkpoints;
- published artifacts;
- installation backups;
- credential/key grants;
- audit records according to retention rules;
- billing records that must legally/accountingly remain.

Deletion is a durable workflow with retry/status, not a single best-effort request across many services.

## Operational tooling

Authorized support operators can inspect:

- identity/membership;
- publish versions;
- storage/checkpoint state;
- entitlement projection;
- provider event processing state;
- bundle/update issuance;
- key-grant outcome;
- normalized errors/correlation IDs.

Support must not expose:

- plaintext datasource credentials;
- password secrets;
- raw protected key material;
- unnecessary payment instrument data.

Privileged support actions must be audited.

## Reconciliation

A scheduled/admin reconciliation process compares provider subscription truth with internal normalized state to detect missed webhooks or drift.

Reconciliation repairs state idempotently and records what changed.

## Acceptance criteria

- New customer can register, pay, publish, invite, run, update, restore, and cancel without operator intervention.
- Duplicate provider event produces no duplicate entitlement/state transition.
- Older out-of-order event cannot regress a newer known commercial state incorrectly.
- Invalid webhook signature is rejected.
- Temporary event-processing failure is retried/reconcilable.
- Concurrent invitations cannot bypass Runtime-user quota.
- Entitlement decision can be traced to source subscription/event.
- Payment grace/cancellation behavior is deterministic and testable.
- Cloud cancellation never disables local desktop/local application use.
- Deletion workflow retries partial failures and exposes completion state.
- Support tooling diagnoses commercial failures without revealing protected secrets.
- Provider/internal reconciliation can repair a deliberately dropped event in test.

## Non-goals

- DRM of the Apache desktop core;
- bespoke enterprise procurement/contracts in MVP;
- provider-specific business logic leaking throughout product services;
- usage-based billing unless separately specified.
