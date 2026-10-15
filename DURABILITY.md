# Worked extension: a retry survives worker replacement

Date: 2026-10-15. This extends the [baseline lab](README.md) with a single-host SQLite adapter. It demonstrates database-local effects through MCP and adds process-crash tests. It does not implement remote authentication or a hosted service.

## 1. Predict the result, then run

Use Node.js 22.13 or newer. Node 22 reports `node:sqlite` as experimental; that is expected. No new npm dependency is required.

```sh
cd mcp-engineering-examples
npm ci --ignore-scripts
npm run demo:durable
npm run test:durable
```

Before running the demo, predict whether closing the original MCP server and starting a replacement will create a second note. The output should include `workerReplaced: true`, `sameResult: true`, and `noteCount: 1`. The note identifier varies. The demo creates a temporary database and removes it after closing both clients; nothing is sent to an external provider.

Before running the tests, predict the durable note and operation-ledger counts for each crash point. Compare with the assertions in `test/durable.test.mjs` rather than treating a green summary as an explanation.

## 2. Trace what changed

The MCP tool names, input schemas, and client calls remain the same. `createServer` now accepts an operations implementation. Its default is the original in-memory domain. The durable adapter implements the same operations against SQL.

`connect` accepts a launcher-owned `databasePath`. The server uses that local file when `LAB_DATABASE` is present. A tool caller cannot pass a database path or tenant through its schema. Fixture identities are still selected by `LAB_PRINCIPAL`; this is not authentication.

`openDurableStore(path, { seed: true })` is an explicit fixture setup step. The server opens the store without seeding, so opening a database is not a hidden instruction to repopulate deleted fixtures. The demo and tests initialize their own temporary files.

Read the files in this order:

1. `durable-demo.mjs`: a write through MCP, worker replacement, identical retry.
2. `durable-store.mjs`: schema, transactions, authorization and bounded reads.
3. `test/durable.test.mjs`: concurrent clients, replacement and state assertions.
4. `test/fixtures/durable-worker.mjs`: deliberate process termination at exact transaction boundaries.

## 3. Follow the transaction

```text
check current write scope
BEGIN IMMEDIATE
  verify incident belongs to the principal's tenant
  look up (tenant, actor, tool, operation key)
  if found: compare payload hash; return original result or conflict
  otherwise: insert note and insert operation record
COMMIT
return the recorded result
```

The payload hash uses an ordered tuple of incident ID and exact note text. It does not depend on the order in which JSON properties arrived. Tenant, actor and tool are part of the unique operation identity. An identical key from another actor represents a different operation; this design does not deduplicate an entire business workflow across users.

The note and ledger entry commit in one transaction. `BEGIN IMMEDIATE` serializes writers to this SQLite database before they check for an existing operation. The primary-key constraint also protects the operation identity. A process kill before commit rolls back the uncommitted transaction; a kill after commit loses the response but leaves the original result available to a replacement process.

Current permission and object ownership are checked before replay. A stored success is not a grant of continuing authority. In this fixture, each process receives a principal at launch; the tests simulate revocation by supplying the current reader-only principal. A remote service must obtain current authorization from its real identity and membership system.

## 4. Inspect the five acceptance tests

| Experiment | Expected durable state |
| --- | --- |
| Two actual MCP server processes submit the same key and payload; a replacement retries | One note, one operation, the same returned note ID |
| Kill a worker after inserting the note but before inserting the ledger entry | Zero notes and zero operations; retry creates one of each |
| Kill a worker after commit but before returning a result | One note and one operation; replacement returns that stored note |
| Revoke write scope, attempt inaccessible objects, then exercise independent tenants and actors | Denials cause no writes; distinct authority scopes have independent operation keys |
| Race two different payloads with one operation key | One success, one conflict, one note and one operation |

The tests send `SIGKILL` to disposable child processes, not to the test runner or any user service. This tests abrupt process death; it does not simulate disk corruption, host power loss, storage failure, or a network partition.

## 5. Understand the next boundary

- SQLite WAL mode and `synchronous=FULL` are enabled. All workers share one local filesystem on one host. This is not a multi-host database architecture, and the file must not be placed on a network filesystem.
- The synchronous driver and five-second busy timeout can block a worker's event loop. This is acceptable for an observable teaching exercise, not evidence of customer-scale latency or fairness.
- Ledger entries are retained indefinitely. There is no expiry policy or cleanup worker. Deleting an entry removes the replay guarantee for that key. A production retention policy must align with the maximum supported retry horizon and storage budget.
- Returned note history stays bounded to the latest ten notes. Stored history and ledger growth are not bounded by that output limit.
- The effect is a database-local note. Sending a message, issuing a refund, or invoking another service requires an outbox/workflow and reconciliation; this transaction cannot commit another provider's state atomically.
- SQLite schema creation is teaching setup, not a production migration strategy. Backups, restores, encryption, durable authorization, quotas, monitoring, and recovery objectives remain separate work.

For a companion repository, keep this as the second progressive example after the baseline. The next example should add the authenticated HTTP boundary without quietly changing these operation semantics.
