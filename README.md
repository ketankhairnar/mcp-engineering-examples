# MCP engineering examples

Runnable companions to [MCP: Protocol to Production](https://www.ketankhairnar.com/deep-dives/mcp-engineering/). Start with protocol understanding and tradeoffs, then build the engineering guarantees one at a time.

This repository contains **complete local learning examples**, not a hosted production MCP product. All data is synthetic. No customer credentials, model account, paid calls, or external business writes are required.

## Start in five minutes

Use Node.js **22.13 or newer** and npm. Node 22 emits an experimental warning for its built-in SQLite module. The dependency lock pins MCP client/server SDK 2.3.1 and Zod 4.6.7; clients explicitly select protocol **2026-07-28**.

```sh
git clone https://github.com/ketankhairnar/mcp-engineering-examples.git
cd mcp-engineering-examples
npm ci --ignore-scripts
npm test
npm run demo
npm run demo:durable
```

Research and initial verification date: 15 October 2026. SDK package version and wire revision are separate choices. See the [protocol mechanics chapter](https://www.ketankhairnar.com/deep-dives/mcp-engineering/02_protocol_mechanics/) before changing them.

## Two progressive examples

| Example | Run | What it demonstrates |
| --- | --- | --- |
| Consume and build two MCP servers | `npm run demo` | Discover incident/deployment tools, join evidence, check fixture tenant/scope, write and retry using a process-local map |
| Preserve a write across worker replacement | `npm run demo:durable` | Use the same MCP contract with a SQLite note/operation transaction, close the first server, retry through a replacement, observe one note |

The first demo prints two `modern` protocol eras and `retryReturnedSameNote: true`. The second prints `workerReplaced: true`, `sameResult: true`, and `noteCount: 1`. Random note identifiers vary. Both demos close their subprocesses; the durable demo removes its temporary database.

The incident and deployment timestamps demonstrate sequence, not causation. The resulting note explicitly calls for investigation before rollback.

## Follow the implementation

1. `domain.mjs`: fixture records, tenant checks, scope checks, process-local replay.
2. `server-factory.mjs`: strict tool schemas, annotations, structured/text results, storage adapter boundary.
3. `server.mjs`: modern stdio entry point; stdout reserved for protocol.
4. `connect.mjs` and `client.mjs`: modern client selection, two-server consumption and cleanup.
5. `durable-store.mjs` and `durable-demo.mjs`: persistence through the same tool contract.
6. `test/`: positive controls, denial assertions, framing, replay and process-crash tests.

Read the [step-by-step baseline walkthrough](https://www.ketankhairnar.com/deep-dives/mcp-engineering/06_worked_example/) and the [durability extension](DURABILITY.md). The full source/evidence ledger remains with the [deep-dive handbook](https://github.com/ketankhairnar/myweb/tree/main/docs/research/mcp-2026).

## Eleven tests, multiple assertions

`npm test` runs all eleven tests. `npm run test:durable` runs the five persistence tests.

The six baseline tests verify modern HTTP metadata/header consistency, cache hints and absence of the legacy handshake; header/body mismatch rejected before mutation; two real stdio servers; schema rejection; tenant checks; authorized and denied writes; replay/conflict; independent tenant keys; revoked replay; and bounded returned note history.

The five extension tests verify two MCP worker processes and a replacement sharing one result; `SIGKILL` before commit rolling back both note and ledger; `SIGKILL` after commit preserving a replayable result; tenant/actor/current-scope checks; and two concurrent different payloads producing one success and one conflict. Crash tests kill only disposable test children.

HTTP framing is tested in-process through an injected fetch function. No HTTP listener, TLS proxy, or OAuth flow is exercised. CI runs the tests and both demos on Linux with Node 22.14 and 24; consult the actual workflow result rather than assuming a configured workflow passed.

## Limits that matter

- `LAB_PRINCIPAL` selects a fixture identity; it is not remote authentication. Tool arguments cannot choose the tenant.
- The default store loses replay history on restart. The optional SQLite adapter persists database-local notes and results for processes sharing one local file on one host.
- SQLite operations are synchronous and can block a worker. No customer-scale throughput or fairness claim is made.
- The operation ledger has no automatic expiry. Deleting records removes their replay guarantee. Storage retention, migrations, backups and recovery remain production decisions.
- An identical operation key under a different actor is a distinct operation. An operation identity is not a universal business-workflow identifier.
- An external side effect requires downstream idempotency, an outbox/workflow, and reconciliation. This database transaction does not give exactly-once execution across services.
- No real OAuth, TLS/Host/Origin middleware, hosted deployment, quotas, LLM task evaluation, or live customer traffic is included.
- Structured output shapes are asserted in tests; explicit output schemas are still a production-contract follow-up.

## Next example: authenticated HTTP service

The planned third stage adds a real authorization-server integration, protected-resource metadata, current tenant membership, a listening HTTP boundary, quotas and traces. It is **not implemented here yet**. Its acceptance tests and subsequent operational milestones are in the [production graduation chapter](https://www.ketankhairnar.com/deep-dives/mcp-engineering/07_production_and_exercises/).

Keep this repository as the canonical executable source. The deep dive owns the explanation and links here; avoid maintaining a second evolving code copy inside the website.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.
