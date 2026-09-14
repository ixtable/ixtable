# 0009. Local async trigger queue

Status: accepted

Record-created and record-updated triggers may run after the initiating transaction by writing a row to a local SQLite queue. The worker runs only while the desktop process is running. There is no cloud worker, cron, or webhook in the MVP.

Jobs carry an idempotency key. Duplicate enqueue is a no-op. Claim sets a lease. A crash leaves `running` rows. The next claim older than the lease returns them to `pending` and increments `attempts`. After `max_attempts` the job is `failed`. Cancel is allowed in `pending` or `running`.

Synchronous triggers stay on the write path. This queue is the async path only.

Proof lives in `idempotent_enqueue_claim_complete_and_lease_recovery` and `retries_then_fails_and_cancel_stops_pending_work`.
