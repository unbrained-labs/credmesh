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
type PreparedStatement = {
  run: (...args: unknown[]) => void;
  get: (...args: unknown[]) => { value: string } | undefined;
};
type BetterSqliteDb = { prepare: (sql: string) => PreparedStatement };

export class SqliteStore implements StateStore {
  private loadStmt: PreparedStatement;
  private saveStmt: PreparedStatement;

  constructor(db: unknown) {
    const database = db as BetterSqliteDb;
    database.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)").run();
    this.loadStmt = database.prepare("SELECT value FROM kv WHERE key = ?");
    this.saveStmt = database.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
  }

  async load(): Promise<AgentState | null> {
    const row = this.loadStmt.get("state");
    return row ? JSON.parse(row.value) : null;
  }

  async save(state: AgentState): Promise<void> {
    this.saveStmt.run("state", JSON.stringify(state));
  }
}
