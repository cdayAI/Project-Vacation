import { describe, it, expect } from "vitest";
import { createPool } from "../store/db.js";

/**
 * Pass 6 — stop the database under a running process.
 *
 * The drill that produced this file: a `serve` process on Postgres, healthy and
 * answering, then `pg_terminate_backend` against its connections — which is
 * what a failover, a restart, an administrator, or a network reset all look
 * like from the client side. The expected outcome, given that every query path
 * converts a store failure into a `DeniedError` and refuses, was a process that
 * stays up refusing work until the database returns.
 *
 * What happened instead was:
 *
 *   node:events:497
 *         throw er; // Unhandled 'error' event
 *   error: terminating connection due to administrator command
 *   Emitted 'error' event on BoundPool instance at:
 *     at Client.idleListener (pg-pool/index.js:62:10)
 *
 * The process exited. Not a refusal, not a degraded mode — the governance plane
 * disappeared, and it did not come back when the database did.
 *
 * The mechanism is a property of `pg.Pool`: a connection that dies while idle
 * has no caller to reject, so the failure surfaces on the pool's own `error`
 * event. An `EventEmitter` with no `error` listener does not drop the event —
 * Node rethrows it as an uncaught exception. `createPool` registered no
 * listener, so every deployment on Postgres would lose every API instance
 * during the failover that `docs/ops/backup-restore-and-dr.md` §5 describes as
 * the routine disaster-recovery path.
 *
 * This test needs no database: the defect is in how the pool is constructed,
 * and a pool with no `error` listener throws the moment one is emitted.
 */

describe("a database connection that dies while idle", () => {
  it("is reported to the pool's owner rather than killing the process", async () => {
    // Nothing is ever connected: the pool is only asked how it would react.
    const pool = createPool("postgresql://unused@127.0.0.1:1/none", 1);
    try {
      expect(() =>
        pool.emit("error", new Error("terminating connection due to administrator command")),
      ).not.toThrow();
    } finally {
      await pool.end();
    }
  });

  it("hands the failure to the caller's reporter so an outage is not silent", async () => {
    const seen: Error[] = [];
    const pool = createPool("postgresql://unused@127.0.0.1:1/none", 1, (error) => {
      seen.push(error);
    });
    try {
      pool.emit("error", new Error("connection terminated unexpectedly"));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.message).toContain("connection terminated");
    } finally {
      await pool.end();
    }
  });

  it("does not let a reporter that itself throws become the crash it prevents", async () => {
    // A logger that fails during a database outage is exactly the moment this
    // handler must not reintroduce the unhandled error it exists to absorb.
    const pool = createPool("postgresql://unused@127.0.0.1:1/none", 1, () => {
      throw new Error("the logger is also having a bad day");
    });
    try {
      expect(() => pool.emit("error", new Error("connection terminated"))).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});
