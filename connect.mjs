import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export async function connect(
  kind,
  principal = "acme-reader",
  { databasePath } = {}
) {
  const client = new Client(
    { name: `incident-lab-consumer-${kind}`, version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./server.mjs", import.meta.url)), kind],
    env: {
      LAB_PRINCIPAL: principal,
      ...(databasePath ? { LAB_DATABASE: databasePath } : {}),
    },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError)
    throw new Error(
      result.content
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
    );
  if (!result.structuredContent)
    throw new Error("Expected structured fixture result");
  return result.structuredContent;
}
