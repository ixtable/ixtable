import type { DocumentConfig, SessionState } from "./types";

export type Mutator = (draft: DocumentConfig) => DocumentConfig;
type Op = {
  mutator: Mutator;
  /** The config after this op, built on the ops before it. */
  config: DocumentConfig;
  resolve: (state: SessionState) => void;
  reject: (reason: unknown) => void;
};

export interface WriterHooks {
  write: (config: DocumentConfig) => Promise<SessionState>;
  /** True when the backend changed the config since the store last wrote or loaded it. */
  stale: () => boolean;
  /** Re-reads the backend config, given the last confirmed one; returns the new base. */
  refresh: (confirmed: DocumentConfig) => Promise<DocumentConfig>;
  /** Shows the optimistic config: the base with every unconfirmed op applied. */
  show: (config: DocumentConfig) => void;
  written: (state: SessionState) => void;
  failed: (reason: unknown) => void;
}

/**
 * Coalescing config writer: at most one write is in flight, and the ops queued
 * meanwhile go out as one write of their latest config. Each op still persists or
 * rejects on its own: when a coalesced write fails, its ops are retried one at a
 * time from the last confirmed config, and later ops are rebuilt without the
 * rejected ones. Mutators run again only on those rare paths and after a reload.
 */
export class ConfigWriter {
  /** The config Rust last confirmed (written or loaded). */
  base: DocumentConfig | null = null;
  /** Counts enqueued ops, so a reader can tell whether a write started meanwhile. */
  generation = 0;
  private ops: Op[] = [];
  private running: Promise<void> | null = null;

  constructor(private hooks: WriterHooks) {}

  /** Resolves once every queued op has reached Rust or failed; never rejects. */
  idle = () => this.running ?? Promise.resolve();

  enqueue(mutator: Mutator, config: DocumentConfig): Promise<SessionState> {
    this.generation += 1;
    const done = new Promise<SessionState>((resolve, reject) =>
      this.ops.push({ mutator, config, resolve, reject }),
    );
    this.running ??= this.drain();
    return done;
  }

  private async drain() {
    try {
      while (this.ops.length) {
        if (this.hooks.stale() && this.base) {
          this.base = await this.hooks.refresh(this.base);
          this.rebuild();
          continue;
        }
        const batch = this.ops.splice(0);
        // Ops queued since were built on this batch's config: they stay valid if it lands.
        if (await this.send(batch.at(-1)!.config, batch)) continue;
        if (batch.length > 1)
          for (const op of batch) {
            const config = this.apply(op, this.base);
            if (config) await this.send(config, [op]);
          }
        this.rebuild();
      }
    } catch (reason) {
      for (const op of this.ops.splice(0)) op.reject(reason);
      this.notify(() => this.hooks.failed(reason));
      if (this.base) this.notify(() => this.hooks.show(this.base!));
    } finally {
      this.running = null;
    }
  }

  /** Writes `config` for `ops`; on failure rejects them only when they were written alone. */
  private async send(config: DocumentConfig, ops: Op[]): Promise<boolean> {
    let state: SessionState;
    try {
      state = await this.hooks.write(config);
    } catch (reason) {
      if (ops.length === 1) ops[0].reject(reason);
      this.notify(() => this.hooks.failed(reason));
      return false;
    }
    this.base = config;
    this.notify(() => this.hooks.written(state));
    for (const op of ops) op.resolve(state);
    return true;
  }

  private apply(op: Op, from: DocumentConfig | null): DocumentConfig | null {
    if (!from) return op.config;
    try {
      return op.mutator(structuredClone(from));
    } catch (reason) {
      op.reject(reason);
      return null;
    }
  }

  /** Re-applies the queued ops on top of the confirmed base and shows the result. */
  private rebuild() {
    let config = this.base;
    if (!config) return;
    this.ops = this.ops.filter((op) => {
      const next = this.apply(op, config);
      if (next) op.config = config = next;
      return next !== null;
    });
    this.notify(() => this.hooks.show(config!));
  }

  /** Runs a store callback; a throwing one must not strand the queue. */
  private notify(run: () => void) {
    try {
      run();
    } catch (reason) {
      console.error(reason);
    }
  }
}
