import { randomUUID } from "node:crypto";

export class DomainError extends Error {}

// Fixture identities are supplied by the local launcher, never by tool arguments.
// They deliberately DO NOT implement remote authentication.
export const principals = Object.freeze({
  "acme-reader": {
    tenant: "acme",
    subject: "alice",
    scopes: ["incidents:read", "deployments:read"],
  },
  "acme-writer": {
    tenant: "acme",
    subject: "alice",
    scopes: ["incidents:read", "deployments:read", "notes:write"],
  },
  "beacon-writer": {
    tenant: "beacon",
    subject: "bob",
    scopes: ["incidents:read", "deployments:read", "notes:write"],
  },
});

export function createStore() {
  return {
    incidents: [
      {
        id: "inc-acme-1",
        tenant: "acme",
        service: "checkout",
        openedAt: "2026-10-15T07:10:00Z",
        title: "Checkout error rate elevated",
        notes: [],
      },
      {
        id: "inc-beacon-1",
        tenant: "beacon",
        service: "checkout",
        openedAt: "2026-10-15T07:12:00Z",
        title: "Beacon private incident",
        notes: [],
      },
    ],
    deployments: [
      {
        id: "dep-acme-1",
        tenant: "acme",
        service: "checkout",
        deployedAt: "2026-10-15T07:05:00Z",
        revision: "a1b2c3",
      },
      {
        id: "dep-beacon-1",
        tenant: "beacon",
        service: "checkout",
        deployedAt: "2026-10-15T07:08:00Z",
        revision: "d4e5f6",
      },
    ],
    operations: new Map(),
  };
}

function requireScope(principal, scope) {
  if (!principal?.scopes.includes(scope)) throw new DomainError("FORBIDDEN");
}

function ownedIncident(store, principal, id) {
  const incident = store.incidents.find(
    row => row.id === id && row.tenant === principal.tenant
  );
  if (!incident) throw new DomainError("NOT_FOUND_OR_NOT_ACCESSIBLE");
  return incident;
}

function publicIncident({ tenant, notes, ...incident }) {
  return structuredClone({
    ...incident,
    notes: notes.slice(-10),
    notesTruncated: notes.length > 10,
  });
}

export function listIncidents(store, principal, service, limit) {
  requireScope(principal, "incidents:read");
  const matches = store.incidents.filter(
    row => row.tenant === principal.tenant && row.service === service
  );
  return {
    items: matches.slice(0, limit).map(publicIncident),
    truncated: matches.length > limit,
  };
}

export function getIncident(store, principal, id) {
  requireScope(principal, "incidents:read");
  return publicIncident(ownedIncident(store, principal, id));
}

export function listDeployments(store, principal, service, limit) {
  requireScope(principal, "deployments:read");
  const matches = store.deployments.filter(
    row => row.tenant === principal.tenant && row.service === service
  );
  return {
    items: matches.slice(0, limit).map(({ tenant, ...row }) => ({ ...row })),
    truncated: matches.length > limit,
  };
}

export function addNote(store, principal, { incidentId, text, operationKey }) {
  // Re-check authorization even for a replay: cached success must not bypass revocation.
  requireScope(principal, "notes:write");
  const incident = ownedIncident(store, principal, incidentId);
  const key = JSON.stringify([
    principal.tenant,
    principal.subject,
    "add_note",
    operationKey,
  ]);
  const fingerprint = JSON.stringify([incidentId, text]);
  const prior = store.operations.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new DomainError("IDEMPOTENCY_CONFLICT");
    return structuredClone(prior.result);
  }
  const result = { noteId: randomUUID(), incidentId, text };
  // Synchronous, one-process critical section. No await occurs between check and save.
  // Production requires a database uniqueness constraint and atomic effect/result commit.
  incident.notes.push(result);
  store.operations.set(key, { fingerprint, result });
  return structuredClone(result);
}
