import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  DomainError,
  listIncidents,
  getIncident,
  listDeployments,
  addNote,
} from "./domain.mjs";

const memoryOperations = {
  listIncidents,
  getIncident,
  listDeployments,
  addNote,
};

const listInput = z
  .object({
    service: z.string().min(1).max(80),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
const noteInput = z
  .object({
    incidentId: z.string().min(1).max(80),
    text: z.string().min(1).max(500),
    operationKey: z.string().min(1).max(100),
  })
  .strict();

function result(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function invoke(fn) {
  return async args => {
    try {
      return result(fn(args));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    }
  };
}

export function createServer(
  kind,
  store,
  principal,
  operations = memoryOperations
) {
  const server = new McpServer({
    name: `incident-lab-${kind}`,
    version: "1.0.0",
  });
  const readHints = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  if (kind === "incidents") {
    server.registerTool(
      "list_incidents",
      {
        description:
          "List accessible incidents for one exact service. Returns at most 20 records and a truncation flag. No writes.",
        inputSchema: listInput,
        annotations: readHints,
      },
      invoke(({ service, limit }) =>
        operations.listIncidents(store, principal, service, limit)
      )
    );
    server.registerTool(
      "get_incident",
      {
        description:
          "Read one accessible incident by its exact ID, including internal notes.",
        inputSchema: z.object({ id: z.string().min(1).max(80) }).strict(),
        annotations: readHints,
      },
      invoke(({ id }) => operations.getIncident(store, principal, id))
    );
    server.registerTool(
      "add_note",
      {
        description:
          "Append an internal incident note. Requires notes:write. Reuse operationKey only for an identical retry. Does not notify anyone. Replay lifetime depends on the configured lab store: process-local by default, retained in the database in durable mode.",
        inputSchema: noteInput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      invoke(args => operations.addNote(store, principal, args))
    );
  } else if (kind === "deployments") {
    server.registerTool(
      "list_deployments",
      {
        description:
          "List accessible deployments for one exact service. Times are evidence of sequence, not proof of incident causation.",
        inputSchema: listInput,
        annotations: readHints,
      },
      invoke(({ service, limit }) =>
        operations.listDeployments(store, principal, service, limit)
      )
    );
  } else throw new Error("Unknown fixture server");
  return server;
}
