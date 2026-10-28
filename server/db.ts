import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `-- An alert, by the fingerprint of its labels: Prometheus, a product or a script sends it again while it holds, and
   -- it resolves when ends_at passes (ADR 0059).
   CREATE TABLE alerts (
     fingerprint TEXT PRIMARY KEY,
     labels TEXT NOT NULL,
     annotations TEXT NOT NULL DEFAULT '{}',
     starts_at TEXT NOT NULL,
     ends_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     generator_url TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX alerts_ends ON alerts (ends_at);
   -- Where notifications go. The URL is a secret (a Slack or Teams webhook holds its key), sealed with the install's key.
   CREATE TABLE contact_points (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK (kind IN ('slack', 'teams', 'webhook')),
     url TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   -- Who is on call: members take turns of shift_hours each, from starts_at.
   CREATE TABLE schedules (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     members TEXT NOT NULL,
     shift_hours INTEGER NOT NULL CHECK (shift_hours > 0),
     starts_at TEXT NOT NULL
   );
   -- In order; the first route whose matchers all match an alert takes it.
   CREATE TABLE routes (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL,
     name TEXT NOT NULL,
     matchers TEXT NOT NULL,
     group_by TEXT NOT NULL,
     contact_point_id TEXT NOT NULL REFERENCES contact_points (id),
     schedule_id TEXT REFERENCES schedules (id),
     repeat_minutes INTEGER NOT NULL,
     escalate_minutes INTEGER,
     escalate_contact_point_id TEXT REFERENCES contact_points (id)
   );
   -- One group per route and values of its group_by labels: the unit people are told about and acknowledge.
   CREATE TABLE groups (
     key TEXT PRIMARY KEY,
     route_id TEXT NOT NULL,
     labels TEXT NOT NULL,
     first_at TEXT NOT NULL,
     -- What the last notification said: the firing fingerprints, so a change is told at once.
     notified_hash TEXT,
     notified_at TEXT,
     acked_by TEXT,
     acked_at TEXT,
     escalated_at TEXT
   );
   CREATE TABLE silences (
     id TEXT PRIMARY KEY,
     matchers TEXT NOT NULL,
     starts_at TEXT NOT NULL,
     ends_at TEXT NOT NULL,
     comment TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   -- Every notification sent, and whether it got through.
   CREATE TABLE notifications (
     id INTEGER PRIMARY KEY,
     group_key TEXT NOT NULL,
     contact_point_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('firing', 'repeat', 'escalation', 'resolved', 'test')),
     at TEXT NOT NULL,
     ok INTEGER NOT NULL,
     error TEXT,
     on_call TEXT
   );
   CREATE INDEX notifications_at ON notifications (at)`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
