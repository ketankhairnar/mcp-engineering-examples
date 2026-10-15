import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDurableStore } from "./durable-store.mjs";
import { connect, call } from "./connect.mjs";

const directory = await mkdtemp(join(tmpdir(), "mcp-durable-demo-"));
const databasePath = join(directory, "lab.sqlite");
const store = openDurableStore(databasePath, { seed: true });
const args = {
  incidentId: "inc-acme-1",
  text: "Investigate the deployment; correlation is not causation.",
  operationKey: "investigation-1",
};
let firstClient;
let replacement;
try {
  firstClient = await connect("incidents", "acme-writer", { databasePath });
  const first = await call(firstClient, "add_note", args);
  await firstClient.close();
  replacement = await connect("incidents", "acme-writer", { databasePath });
  const replay = await call(replacement, "add_note", args);
  assert.deepEqual(replay, first);
  const noteCount = store.db.prepare("SELECT count(*) n FROM notes").get().n;
  assert.equal(noteCount, 1);
  console.log(
    JSON.stringify(
      { workerReplaced: true, sameResult: true, noteCount, result: replay },
      null,
      2
    )
  );
} finally {
  await firstClient?.close();
  await replacement?.close();
  store.close();
  await rm(directory, { recursive: true, force: true });
}
