// Standalone harness: boots the canvas server with live Azure data so the UI can
// be exercised (and screenshotted) without the Copilot runtime. Not shipped.
import crypto from "node:crypto";
import { discoverFrontDoors, normalizeAgentTopology } from "./frontdoor.mjs";
import { createCanvasServer } from "./server.mjs";

const useDemo = process.argv.includes("--demo");

const instanceId = "harness";
const token = crypto.randomBytes(8).toString("hex");
const instance = { token, topology: null, status: { phase: "loading", message: "Starting…" }, selectedNodeId: null, selectedProfileId: null };

const store = {
  peek: () => instance,
  update: (_id, mutate) => (mutate(instance), instance),
  snapshot: () => ({
    status: instance.status,
    topology: instance.topology,
    selectedNodeId: instance.selectedNodeId,
    selectedProfileId: instance.selectedProfileId,
  }),
};

const server = createCanvasServer({
  store,
  onRefresh: async () => scan(),
  onAsk: () => true,
});

async function scan() {
  instance.status = { phase: "loading", message: "Scanning…" };
  server.broadcast(instanceId, "status", instance.status);
  const topology = useDemo
    ? normalizeAgentTopology((await import("./demo-data.mjs")).demoTopology)
    : await discoverFrontDoors({
        onProgress: (message) => {
          instance.status = { phase: "loading", message };
          server.broadcast(instanceId, "status", instance.status);
        },
      });
  instance.topology = topology;
  instance.selectedProfileId = topology.profiles[0]?.id ?? null;
  instance.status = { phase: topology.profiles.length ? "ready" : "empty", message: "" };
  server.broadcast(instanceId, "topology", { topology, status: instance.status });
  return topology;
}

const port = await server.listen();
const url = `http://127.0.0.1:${port}/?instance=${instanceId}&token=${token}`;
console.log("URL:", url);
const topology = await scan();
console.log("profiles:", topology.profiles.map((p) => `${p.name} (${p.nodes.length} nodes)`).join(", "));
console.log("READY");
