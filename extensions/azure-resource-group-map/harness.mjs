// Standalone harness: boots the canvas server with live Azure data so the UI can
// be exercised (and screenshotted) without the Copilot runtime. Not shipped.
import crypto from "node:crypto";
import { discoverResourceMap, normalizeAgentMap } from "./resources.mjs";
import { createCanvasServer } from "./server.mjs";

const useDemo = process.argv.includes("--demo");

const instanceId = "harness";
const token = crypto.randomBytes(8).toString("hex");
const instance = { token, map: null, status: { phase: "loading", message: "Starting…" }, selection: null };

const store = {
  peek: () => instance,
  update: (_id, mutate) => (mutate(instance), instance),
  snapshot: () => ({ status: instance.status, map: instance.map, selection: instance.selection }),
};

const server = createCanvasServer({ store, onRefresh: async () => scan(), onAsk: () => true });

async function scan() {
  instance.status = { phase: "loading", message: "Scanning…" };
  server.broadcast(instanceId, "status", instance.status);
  const map = useDemo
    ? normalizeAgentMap((await import("./demo-data.mjs")).demoMap)
    : await discoverResourceMap({
        onProgress: (message) => {
          instance.status = { phase: "loading", message };
          server.broadcast(instanceId, "status", instance.status);
        },
      });
  instance.map = map;
  instance.status = { phase: map.groups.length ? "ready" : "empty", message: "" };
  server.broadcast(instanceId, "map", { map, status: instance.status });
  return map;
}

const port = await server.listen();
console.log("URL:", `http://127.0.0.1:${port}/?instance=${instanceId}&token=${token}`);
const map = await scan();
console.log("groups:", map.stats.totalGroups, "resources:", map.stats.totalResources);
console.log("READY");
