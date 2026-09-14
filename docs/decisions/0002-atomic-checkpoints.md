# 0002. Crash-safe atomic checkpoints

Status: accepted

A checkpoint writes a complete temporary SQLite file, fsyncs, validates by reopening it, then `rename`s onto the destination. The previous `.ixt` stays readable until rename succeeds. A sibling leftover `.partial` file is trash. Recovery never promotes it.

Attachments live as compressed rows inside the same transaction. A 4 MiB incompressible payload round-trips by checksum. Phase 1 still needs streaming import so a 500 MB archive does not sit fully in RAM. That is a size engineering task, not an architecture change. Atomic rename remains the crash boundary.

If autosave during a huge rewrite becomes too slow, keep this rename protocol and change how the temp file is produced (incremental SQLite backup into the temp path). Do not make the live `.ixt` the writer.

Proof lives in `interrupted_write_keeps_last_valid_checkpoint` and `large_asset_checkpoint_round_trips_checksum`.
