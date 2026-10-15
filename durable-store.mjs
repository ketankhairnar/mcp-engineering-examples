import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { createStore, DomainError } from "./domain.mjs";

// A single-host teaching adapter. Workers share a local file, never a network FS.
export function openDurableStore(
  path,
  { seed = false, checkpoint = () => {} } = {}
) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS incidents (
      tenant TEXT NOT NULL, id TEXT NOT NULL, service TEXT NOT NULL,
      opened_at TEXT NOT NULL, title TEXT NOT NULL, PRIMARY KEY (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS deployments (
      tenant TEXT NOT NULL, id TEXT NOT NULL, service TEXT NOT NULL,
      deployed_at TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS notes (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
      tenant TEXT NOT NULL, incident_id TEXT NOT NULL, actor TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (tenant, incident_id) REFERENCES incidents (tenant, id)
    );
    CREATE TABLE IF NOT EXISTS operations (
      tenant TEXT NOT NULL, actor TEXT NOT NULL, tool TEXT NOT NULL,
      operation_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      note_id TEXT NOT NULL REFERENCES notes(id),
      PRIMARY KEY (tenant, actor, tool, operation_key)
    );
  `);
  if (seed) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const fixture = createStore();
      for (const row of fixture.incidents)
        db.prepare(
          "INSERT OR IGNORE INTO incidents VALUES (?, ?, ?, ?, ?)"
        ).run(row.tenant, row.id, row.service, row.openedAt, row.title);
      for (const row of fixture.deployments)
        db.prepare(
          "INSERT OR IGNORE INTO deployments VALUES (?, ?, ?, ?, ?)"
        ).run(row.tenant, row.id, row.service, row.deployedAt, row.revision);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  return { db, checkpoint, close: () => db.close() };
}

function requireScope(principal, scope) {
  if (!principal?.scopes?.includes(scope)) throw new DomainError("FORBIDDEN");
}

function ownedIncident(store, principal, id) {
  const row = store.db
    .prepare("SELECT * FROM incidents WHERE tenant = ? AND id = ?")
    .get(principal.tenant, id);
  if (!row) throw new DomainError("NOT_FOUND_OR_NOT_ACCESSIBLE");
  return row;
}

function publicIncident(store, row) {
  const notes = store.db
    .prepare(
      `SELECT id AS noteId, incident_id AS incidentId, text
    FROM notes WHERE tenant = ? AND incident_id = ? ORDER BY seq DESC LIMIT 11`
    )
    .all(row.tenant, row.id);
  return {
    id: row.id,
    service: row.service,
    openedAt: row.opened_at,
    title: row.title,
    notes: notes
      .slice(0, 10)
      .reverse()
      .map(note => ({ ...note })),
    notesTruncated: notes.length > 10,
  };
}

export const durableOperations = {
  listIncidents(store, principal, service, limit) {
    requireScope(principal, "incidents:read");
    const rows = store.db
      .prepare(
        `SELECT * FROM incidents
      WHERE tenant = ? AND service = ? ORDER BY id LIMIT ?`
      )
      .all(principal.tenant, service, limit + 1);
    return {
      items: rows.slice(0, limit).map(row => publicIncident(store, row)),
      truncated: rows.length > limit,
    };
  },
  getIncident(store, principal, id) {
    requireScope(principal, "incidents:read");
    return publicIncident(store, ownedIncident(store, principal, id));
  },
  listDeployments(store, principal, service, limit) {
    requireScope(principal, "deployments:read");
    const rows = store.db
      .prepare(
        `SELECT id, service, deployed_at AS deployedAt, revision
      FROM deployments WHERE tenant = ? AND service = ? ORDER BY id LIMIT ?`
      )
      .all(principal.tenant, service, limit + 1);
    return {
      items: rows.slice(0, limit).map(row => ({ ...row })),
      truncated: rows.length > limit,
    };
  },
  addNote(store, principal, { incidentId, text, operationKey }) {
    // The caller supplies a trusted principal. This is still not authentication.
    requireScope(principal, "notes:write");
    const key = [principal.tenant, principal.subject, "add_note", operationKey];
    // A fixed ordered tuple, not arbitrary JSON property ordering.
    const hash = createHash("sha256")
      .update(JSON.stringify([incidentId, text]))
      .digest("hex");
    const { db, checkpoint } = store;
    db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    let result;
    try {
      ownedIncident(store, principal, incidentId);
      const prior = db
        .prepare(
          `SELECT payload_hash, note_id FROM operations
        WHERE tenant = ? AND actor = ? AND tool = ? AND operation_key = ?`
        )
        .get(...key);
      if (prior) {
        if (prior.payload_hash !== hash)
          throw new DomainError("IDEMPOTENCY_CONFLICT");
        result = {
          ...db
            .prepare(
              "SELECT id AS noteId, incident_id AS incidentId, text FROM notes WHERE id = ? AND tenant = ?"
            )
            .get(prior.note_id, principal.tenant),
        };
      } else {
        result = { noteId: randomUUID(), incidentId, text };
        db.prepare(
          "INSERT INTO notes (id, tenant, incident_id, actor, text) VALUES (?, ?, ?, ?, ?)"
        ).run(
          result.noteId,
          principal.tenant,
          incidentId,
          principal.subject,
          text
        );
        // Trusted test seam; no protocol argument can trigger it.
        checkpoint("after-note-before-ledger");
        db.prepare("INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?)").run(
          ...key,
          hash,
          result.noteId
        );
        db.exec("COMMIT");
        transactionOpen = false;
        checkpoint("after-commit-before-response");
        return result;
      }
      db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) db.exec("ROLLBACK");
      throw error;
    }
  },
};
