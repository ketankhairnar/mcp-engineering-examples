import test from "node:test";
import assert from "node:assert/strict";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createServer } from "../server-factory.mjs";
import { createStore, principals } from "../domain.mjs";

test("modern HTTP client sends matching per-request metadata; raw responses carry framing", async () => {
  const store = createStore();
  const handler = createMcpHandler(
    () => createServer("incidents", store, principals["acme-reader"]),
    { legacy: "reject" }
  );
  const exchanges = [];
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        const body = await request.clone().json();
        const response = await handler.fetch(request);
        exchanges.push({
          body,
          headers: request.headers,
          response: await response.clone().json(),
        });
        return response;
      },
    }
  );
  const client = new Client(
    { name: "http-lab", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  try {
    await client.connect(transport);
    await client.listTools();
    const result = await client.callTool({
      name: "get_incident",
      arguments: { id: "inc-acme-1" },
    });
    assert.equal(result.structuredContent.id, "inc-acme-1");
    assert.equal(client.getProtocolEra(), "modern");
    assert.ok(exchanges.some(e => e.body.method === "server/discover"));
    assert.ok(!exchanges.some(e => e.body.method === "initialize"));
    for (const { body, headers, response } of exchanges) {
      assert.equal(
        body.params._meta["io.modelcontextprotocol/protocolVersion"],
        "2026-07-28"
      );
      assert.equal(headers.get("MCP-Protocol-Version"), "2026-07-28");
      assert.equal(headers.get("Mcp-Method"), body.method);
      assert.equal(response.result.resultType, "complete");
      if (body.method === "tools/call")
        assert.equal(headers.get("Mcp-Name"), body.params.name);
    }
    const listed = exchanges.find(e => e.body.method === "tools/list").response
      .result;
    assert.equal(typeof listed.ttlMs, "number");
    assert.ok(["private", "public"].includes(listed.cacheScope));
  } finally {
    await client.close();
    await handler.close();
  }
});

test("HTTP header/body method disagreement is rejected before domain dispatch", async () => {
  const store = createStore();
  const handler = createMcpHandler(
    () => createServer("incidents", store, principals["acme-writer"]),
    { legacy: "reject" }
  );
  try {
    const response = await handler.fetch(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
          "Mcp-Name": "add_note",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_note",
            arguments: {
              incidentId: "inc-acme-1",
              text: "must not execute",
              operationKey: "mismatch",
            },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      })
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32020);
    assert.equal(store.incidents[0].notes.length, 0);
  } finally {
    await handler.close();
  }
});
