import test from "node:test";
import assert from "node:assert/strict";
import { connect, call } from "../connect.mjs";
import { createStore, principals, addNote, getIncident } from "../domain.mjs";

test(
  "two real stdio servers select the modern era, discover, and isolate reads",
  { timeout: 15000 },
  async () => {
    const clients = [];
    try {
      const incidents = await connect("incidents");
      clients.push(incidents);
      const deployments = await connect("deployments");
      clients.push(deployments);
      for (const c of clients) assert.equal(c.getProtocolEra(), "modern");
      assert.deepEqual(
        (await incidents.listTools()).tools.map(t => t.name).sort(),
        ["add_note", "get_incident", "list_incidents"]
      );
      assert.deepEqual(
        (await deployments.listTools()).tools.map(t => t.name),
        ["list_deployments"]
      );
      const inc = await call(incidents, "list_incidents", {
        service: "checkout",
        limit: 1,
      });
      const dep = await call(deployments, "list_deployments", {
        service: "checkout",
        limit: 1,
      });
      assert.equal(inc.items.length, 1);
      assert.equal(inc.items[0].id, "inc-acme-1");
      assert.equal(dep.items[0].id, "dep-acme-1");
      for (const id of ["inc-beacon-1", "missing"]) {
        await assert.rejects(
          call(incidents, "get_incident", { id }),
          /NOT_FOUND_OR_NOT_ACCESSIBLE/
        );
      }
      await assert.rejects(
        call(incidents, "list_incidents", { service: "checkout", limit: 1000 })
      );
      await assert.rejects(
        call(incidents, "list_incidents", {
          service: "checkout",
          tenant: "beacon",
        })
      );
      await assert.rejects(
        call(incidents, "add_note", {
          incidentId: "inc-acme-1",
          text: "denied",
          operationKey: "reader",
        }),
        /FORBIDDEN/
      );
      assert.equal(
        (await call(incidents, "get_incident", { id: "inc-acme-1" })).notes
          .length,
        0
      );
    } finally {
      await Promise.allSettled(clients.map(c => c.close()));
    }
  }
);

test(
  "authorized MCP write, replay and conflict have exactly one local effect",
  { timeout: 15000 },
  async () => {
    const c = await connect("incidents", "acme-writer");
    try {
      const args = {
        incidentId: "inc-acme-1",
        text: "Investigate correlation",
        operationKey: "op-1",
      };
      const first = await call(c, "add_note", args);
      const replay = await call(c, "add_note", args);
      assert.deepEqual(replay, first);
      await assert.rejects(
        call(c, "add_note", { ...args, text: "Different operation" }),
        /IDEMPOTENCY_CONFLICT/
      );
      await assert.rejects(
        call(c, "add_note", { ...args, incidentId: "inc-beacon-1" }),
        /NOT_FOUND_OR_NOT_ACCESSIBLE/
      );
      const incident = await call(c, "get_incident", { id: args.incidentId });
      assert.equal(incident.notes.length, 1);
      assert.equal(incident.notes[0].text, args.text);
    } finally {
      await c.close();
    }
  }
);

test("same operation key across tenants does not collide in shared storage", () => {
  const store = createStore();
  const a = addNote(store, principals["acme-writer"], {
    incidentId: "inc-acme-1",
    text: "A",
    operationKey: "same",
  });
  const b = addNote(store, principals["beacon-writer"], {
    incidentId: "inc-beacon-1",
    text: "B",
    operationKey: "same",
  });
  assert.notEqual(a.noteId, b.noteId);
  assert.equal(store.operations.size, 2);
  assert.deepEqual(
    store.incidents.map(i => i.notes.length),
    [1, 1]
  );
});

test("revoked replay is denied; returned history remains bounded as notes accumulate", () => {
  const store = createStore();
  const args = {
    incidentId: "inc-acme-1",
    text: "Allowed once",
    operationKey: "op",
  };
  addNote(store, principals["acme-writer"], args);
  assert.throws(
    () => addNote(store, principals["acme-reader"], args),
    /FORBIDDEN/
  );
  assert.equal(store.incidents[0].notes.length, 1);
  for (let i = 0; i < 12; i++) {
    addNote(store, principals["acme-writer"], {
      ...args,
      text: `Note ${i}`,
      operationKey: `bounded-${i}`,
    });
  }
  const view = getIncident(store, principals["acme-reader"], "inc-acme-1");
  assert.equal(view.notes.length, 10);
  assert.equal(view.notesTruncated, true);
  assert.equal(view.notes.at(-1).text, "Note 11");
});
