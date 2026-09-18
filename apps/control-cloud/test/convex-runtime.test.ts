import { test } from "node:test";
import assert from "node:assert/strict";
import { observeConvexRuntime } from "../src/convex-runtime.ts";
function fixture() {
  const job = {
    Constraints: [
      { LTarget: "${node.unique.id}", Operand: "=", RTarget: "node" },
    ],
    TaskGroups: [
      {
        Count: 1,
        ReschedulePolicy: { Attempts: 0, Unlimited: false },
        Tasks: [
          {
            Driver: "docker",
            Config: {
              image:
                "ghcr.io/get-convex/convex-backend@sha256:" + "a".repeat(64),
              volumes: ["/var/lib/convex/app:/convex/data"],
              env: { INSTANCE_SECRET: "never-return" },
            },
          },
        ],
      },
    ],
  };
  const ctx = {
    store: {
      get: (_: string, id: string) => (id === "machine" ? { id } : undefined),
    },
    requestNomad: async (method: string, path: string) => {
      assert.equal(method, "GET");
      if (path.endsWith("/allocations"))
        return [
          {
            ID: "alloc",
            NodeID: "node",
            DesiredStatus: "run",
            ClientStatus: "running",
          },
        ];
      if (path.includes("/node/"))
        return { ID: "node", Meta: { pc_machine_id: "machine" } };
      return job;
    },
  };
  return { ctx, job };
}
test("adoption observes pinned runtime without returning task credentials or changing jobs", async () => {
  const { ctx } = fixture();
  const result = await observeConvexRuntime(ctx, "convex-app");
  assert.equal(result.status, "running");
  assert.equal(result.data_path, "/var/lib/convex/app");
  assert.equal(result.machine_id, "machine");
  assert.ok(!JSON.stringify(result).includes("never-return"));
});
test("adoption rejects allocation-local data and automatic relocation", async () => {
  for (const broken of ["volume", "relocation", "pin", "workspace"]) {
    const { ctx, job } = fixture();
    if (broken === "volume")
      job.TaskGroups[0].Tasks[0].Config.volumes = ["named:/convex/data"];
    if (broken === "relocation")
      job.TaskGroups[0].ReschedulePolicy.Attempts = 1;
    if (broken === "pin") job.Constraints = [];
    if (broken === "workspace") ctx.store.get = () => undefined;
    await assert.rejects(observeConvexRuntime(ctx, "convex-app"));
  }
});
