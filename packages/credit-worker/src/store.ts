/**
 * Platform-agnostic state persistence.
 *
 * The CreditAgent engine needs two operations:
 *   - load(): read the full state JSON
 *   - save(state): write the full state JSON
 *
 * Implementations:
 *   - SqliteStore: production (Node.js + better-sqlite3)
 *   - MemoryStore: testing
 */

import type { AgentState } from "./types";

export interface StateStore {
  load(): Promise<AgentState | null>;
  save(state: AgentState): Promise<void>;
}

/**
 * In-memory store for testing.
 */
export class MemoryStore implements StateStore {
  private state: AgentState | null = null;

  async load(): Promise<AgentState | null> {
    return this.state;
  }

  async save(state: AgentState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/**
 * SQLite store for Node.js hosts.
 * Requires `better-sqlite3` package.
 *
 * Usage:
 *   import Database from "better-sqlite3";
 *   const store = new SqliteStore(new Database("./data/credmesh.db"));
 */
export class SqliteStore implements StateStore {
  private db: { prepare: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => { value: string } | undefined } };

  constructor(db: unknown) {
    this.db = db as typeof this.db;
    this.db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)").run();
  }

  async load(): Promise<AgentState | null> {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get("state");
    return row ? JSON.parse(row.value) : null;
  }

  async save(state: AgentState): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run("state", JSON.stringify(state));
  }
}
