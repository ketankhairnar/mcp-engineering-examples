import { openDurableStore, durableOperations } from "../../durable-store.mjs";
import { principals } from "../../domain.mjs";

const [path, crashAt = "", principalName = "acme-writer"] =
  process.argv.slice(2);
const store = openDurableStore(path, {
  checkpoint(stage) {
    if (stage === crashAt) process.kill(process.pid, "SIGKILL");
  },
});
process.on("message", args => {
  try {
    const result = durableOperations.addNote(
      store,
      principals[principalName],
      args
    );
    store.close();
    process.send({ result }, () => process.exit(0));
  } catch (error) {
    store.close();
    process.send({ error: error.message }, () => process.exit(1));
  }
});
process.send({ ready: true });
