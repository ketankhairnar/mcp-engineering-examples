import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createStore, principals } from "./domain.mjs";
import { createServer } from "./server-factory.mjs";

const kind = process.argv[2];
const principal = principals[process.env.LAB_PRINCIPAL];
if (!principal) throw new Error("Choose a documented LAB_PRINCIPAL fixture");
const durable = process.env.LAB_DATABASE
  ? await import("./durable-store.mjs")
  : null;
const store = durable
  ? durable.openDurableStore(process.env.LAB_DATABASE)
  : createStore();
if (durable) process.on("exit", () => store.close());
// stdout belongs exclusively to the protocol. Diagnostics would go to stderr.
serveStdio(
  () => createServer(kind, store, principal, durable?.durableOperations),
  { legacy: "reject" }
);
