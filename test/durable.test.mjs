import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import {
  openDurableStore,
  durableOperations as ops,
} from "../durable-store.mjs";
import { principals } from "../domain.mjs";
import { connect, call } from "../connect.mjs";

const args = {
  incidentId: "inc-acme-1",
  text: "Investigate deployment",
  operationKey: "investigation-1",
};
async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-durable-"));
  const path = join(directory, "lab.sqlite");
  const store = openDurableStore(path, { seed: true });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { path, store };
}
function counts(store) {
  return [
    store.db.prepare("SELECT count(*) n FROM notes").get().n,
    store.db.prepare("SELECT count(*) n FROM operations").get().n,
  ];
}
function worker(path, crashAt = "") {
  const child = fork(
    new URL("./fixtures/durable-worker.mjs", import.meta.url),
    [path, crashAt],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  let message;
  let stderr = "";
  child.stderr.on("data", data => {
    stderr += data;
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.on("message", value => {
    if (value.ready) readyResolve();
    else message = value;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", error => {
      clearTimeout(timeout);
      readyReject(error);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      readyReject(new Error(`Worker exited before ready: ${stderr}`));
      resolve({ code, signal, message });
    });
  });
  return { ready, done, send: payload => child.send(payload) };
}

test("two MCP workers and a replacement worker replay one durable effect", async t => {
  const { path, store } = await database(t);
  const options = { databasePath: path };
  const a = await connect("incidents", "acme-writer", options);
  const b = await connect("incidents", "acme-writer", options);
  try {
    const [first, simultaneous] = await Promise.all([
      call(a, "add_note", args),
      call(b, "add_note", args),
    ]);
    assert.deepEqual(simultaneous, first);
    assert.deepEqual(counts(store), [1, 1]);
    await a.close();
    const replacement = await connect("incidents", "acme-writer", options);
    try {
      assert.deepEqual(await call(replacement, "add_note", args), first);
      const incident = await call(replacement, "get_incident", {
        id: args.incidentId,
      });
      assert.deepEqual(incident.notes, [first]);
      await assert.rejects(
        call(replacement, "add_note", { ...args, text: "Changed" }),
        /IDEMPOTENCY_CONFLICT/
      );
    } finally {
      await replacement.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
  assert.deepEqual(counts(store), [1, 1]);
});

test("SIGKILL between note insertion and ledger insertion rolls back both", async t => {
  const { path, store } = await database(t);
  const crashed = worker(path, "after-note-before-ledger");
  await crashed.ready;
  crashed.send(args);
  assert.equal((await crashed.done).signal, "SIGKILL");
  assert.deepEqual(counts(store), [0, 0]);
  const retry = ops.addNote(store, principals["acme-writer"], args);
  assert.ok(retry.noteId);
  assert.deepEqual(counts(store), [1, 1]);
});

test("SIGKILL after commit loses response but replacement returns stored result", async t => {
  const { path, store } = await database(t);
  const crashed = worker(path, "after-commit-before-response");
  await crashed.ready;
  crashed.send(args);
  assert.equal((await crashed.done).signal, "SIGKILL");
  assert.deepEqual(counts(store), [1, 1]);
  const noteId = store.db.prepare("SELECT id FROM notes").get().id;
  const retry = worker(path);
  await retry.ready;
  retry.send(args);
  const outcome = await retry.done;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.message.result.noteId, noteId);
  assert.deepEqual(counts(store), [1, 1]);
});

test("durable replay retains tenant/actor boundaries and checks current scope", async t => {
  const { store } = await database(t);
  const acme = principals["acme-writer"];
  const first = ops.addNote(store, acme, args);
  assert.throws(
    () => ops.addNote(store, principals["acme-reader"], args),
    /FORBIDDEN/
  );
  for (const id of ["inc-beacon-1", "missing"])
    assert.throws(
      () => ops.addNote(store, acme, { ...args, incidentId: id }),
      /NOT_FOUND_OR_NOT_ACCESSIBLE/
    );
  assert.deepEqual(counts(store), [1, 1]);
  const beacon = ops.addNote(store, principals["beacon-writer"], {
    ...args,
    incidentId: "inc-beacon-1",
  });
  const secondActor = ops.addNote(store, { ...acme, subject: "charlie" }, args);
  assert.equal(
    new Set([first.noteId, beacon.noteId, secondActor.noteId]).size,
    3
  );
  assert.deepEqual(counts(store), [3, 3]);
  for (let i = 0; i < 12; i++)
    ops.addNote(store, acme, { ...args, operationKey: `extra-${i}` });
  const incident = ops.getIncident(store, acme, args.incidentId);
  assert.equal(incident.notes.length, 10);
  assert.equal(incident.notesTruncated, true);
  assert.equal(ops.listIncidents(store, acme, "checkout", 5).items.length, 1);
  assert.equal(
    ops.listDeployments(store, acme, "checkout", 5).items[0].id,
    "dep-acme-1"
  );
});

test("concurrent different payloads with one key yield one success and one conflict", async t => {
  const { path, store } = await database(t);
  const a = worker(path);
  const b = worker(path);
  await Promise.all([a.ready, b.ready]);
  a.send(args);
  b.send({ ...args, text: "A competing note" });
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  assert.equal(
    results.filter(r => r.message?.error === "IDEMPOTENCY_CONFLICT").length,
    1
  );
  assert.deepEqual(counts(store), [1, 1]);
});
