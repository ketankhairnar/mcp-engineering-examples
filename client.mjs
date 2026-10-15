import { connect, call } from "./connect.mjs";

const connections = [];
try {
  // These identities select synthetic local fixtures. No provider credentials are used.
  const incidents = await connect("incidents", "acme-writer");
  connections.push(incidents);
  const deployments = await connect("deployments");
  connections.push(deployments);
  const catalogs = await Promise.all(connections.map(c => c.listTools()));
  console.log(
    "Protocol eras:",
    connections.map(c => c.getProtocolEra())
  );
  console.log(
    "Discovered tools:",
    catalogs.map(c => c.tools.map(t => t.name))
  );
  const [incidentRows, deploymentRows] = await Promise.all([
    call(incidents, "list_incidents", { service: "checkout" }),
    call(deployments, "list_deployments", { service: "checkout" }),
  ]);
  const incident = incidentRows.items[0];
  const candidate = deploymentRows.items.find(
    d =>
      d.service === incident.service &&
      Date.parse(d.deployedAt) <= Date.parse(incident.openedAt)
  );
  if (!candidate)
    throw new Error(
      "No preceding deployment evidence in bounded fixture results"
    );
  const text = `Deployment ${candidate.id} preceded ${incident.id}; temporal correlation only. Investigate before rollback.`;
  const args = { incidentId: incident.id, text, operationKey: "demo-note-1" };
  // The script intentionally records a synthetic internal note, under fixture write scope.
  // A production host must apply its own trusted operation-approval policy before dispatch.
  const first = await call(incidents, "add_note", args);
  const retry = await call(incidents, "add_note", args);
  console.log(
    JSON.stringify(
      {
        incident: incident.id,
        candidate: candidate.id,
        note: first,
        retryReturnedSameNote: first.noteId === retry.noteId,
      },
      null,
      2
    )
  );
} finally {
  await Promise.allSettled(connections.map(c => c.close()));
}
