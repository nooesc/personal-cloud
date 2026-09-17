import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  wr = createRequire(require.resolve("wrangler/package.json"));
const { build } = wr("esbuild"),
  { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
test("backup scheduling, R2 checksum, workspace isolation, isolated restore and retention use real workerd storage", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `import {DurableObject} from 'cloudflare:workers';import {SqlStore} from './src/store';import {handleBackups,reconcileBackups} from './src/runtime/backups';import {handleRuntime} from './src/runtime';import {seal,open} from './src/crypto';
 export class TestWorkspace extends DurableObject {constructor(s,e){super(s,e);this.store=new SqlStore(s.storage)}async fetch(r){let s=this.store,w=r.headers.get('workspace'),path=new URL(r.url).pathname;const secret='local-test-only-key-00000000000000000';let ctx={store:s,env:this.env,workspaceId:w,userId:r.headers.get('user'),broadcast(){},event(){},async schedule(delay){s.put("test_alarms","latest",{delay})},seal:(p,v)=>seal(secret,w+p,v),open:(p,v)=>open(secret,w+p,v),async requestNomad(method,path,body){if(path==='/v1/nodes')return[{ID:'node'}];if(path==='/v1/node/node')return {ID:'node',Status:'ready',SchedulingEligibility:'eligible',Meta:{pc_machine_id:'m',pc_database:'true'},Drivers:{docker:{Healthy:true}}};if(path==='/v1/jobs'){s.put('jobs',body.Job.ID,body.Job);return {}};if(path.includes('/allocations')){let job=path.split('/')[3];return s.get('completion',job)?[{ID:job,NodeID:'node',ClientStatus:'complete'}]:[]};if(path.startsWith('/v1/allocation/'))return{TaskStates:{postgres:{State:'dead',Failed:false},transfer:{State:'dead',Failed:false}}};if(path.startsWith('/v1/job/')){let id=path.split('/')[3];if(method==='DELETE'){s.delete('jobs',id);return {}};let j=s.get('jobs',id);if(j)return j;throw Object.assign(Error('missing'),{status:404})};throw Error('unexpected scheduler request')}};
 try{if(path==='/seed'){s.put('projects','p',{id:'p'});s.put('machines','m',{id:'m'});s.put('databases','db',{id:'db',project_id:'p',name:'Fixture',status:'healthy',phase:'ready',nomad_node_id:'node',machine_id:'m',connection_encrypted:await ctx.seal('database:db','postgresql://test:secret@127.0.0.1:5432/test')});return Response.json({})};if(path==='/tick'){await reconcileBackups(ctx);return Response.json({})};if(path==='/inspect')return Response.json({backups:s.list('database_backups'),jobs:s.list('jobs'),databases:s.list('databases')});if(path==='/failed_empty'){s.put('database_backups','empty',{id:'empty',database_id:'db',kind:'backup',status:'failed',created_at:new Date().toISOString()});return Response.json({})};if(path==='/alarm')return Response.json(s.get('test_alarms','latest'));if(path==='/forget_checksum'){let b=s.list('database_backups')[0];delete b.checksum;delete b.size;s.put('database_backups',b.id,b);return Response.json({})};if(path==='/complete'){let b=await r.json();s.put('completion',b.id,{id:b.id});return Response.json({})};if(path==='/healthy'){let {id}=await r.json();s.put('databases',id,{...s.get('databases',id),status:'healthy',phase:'ready'});return Response.json({})};return await handleBackups(r,ctx) ?? await handleRuntime(r,ctx)}catch(e){return Response.json({error:e.message},{status:e.status||500})}}}
 export default {fetch(r,e){return e.WORKSPACES.getByName(r.headers.get('workspace')).fetch(r)}}`;
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-15",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        WORKSPACES: { className: "TestWorkspace", useSQLite: true },
      },
      r2Buckets: ["ARTIFACTS"],
      bindings: { PUBLIC_URL: "https://local.test" },
    }),
  );
  let container;
  let dump = Buffer.from("test PostgreSQL dump fixture");
  try {
    if (process.env.PC_BACKUP_POSTGRES === "1") {
      container = "dinghy-backup-test-" + crypto.randomUUID();
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--name",
          container,
          "-e",
          "POSTGRES_PASSWORD=local-fixture-only",
          "postgres:17-alpine",
        ],
        { stdio: "pipe" },
      );
      let ready = false;
      for (let i = 0; i < 60; i++) {
        try {
          execFileSync(
            "docker",
            [
              "exec",
              container,
              "pg_isready",
              "-h",
              "127.0.0.1",
              "-U",
              "postgres",
            ],
            { stdio: "pipe" },
          );
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      assert(ready);
      execFileSync("docker", [
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE TABLE backup_marker(id integer PRIMARY KEY, value text); INSERT INTO backup_marker VALUES (1, 'preserved across R2 restore');",
      ]);
      dump = execFileSync(
        "docker",
        [
          "exec",
          container,
          "pg_dump",
          "-U",
          "postgres",
          "-Fc",
          "--no-owner",
          "--no-acl",
          "postgres",
        ],
        { maxBuffer: 10 * 1024 * 1024 },
      );
    }
    const call = async (
      path,
      method = "GET",
      body,
      extra = {},
      expected = 200,
    ) => {
      const r = await mf.dispatchFetch("https://local.test" + path, {
        method,
        headers: { workspace: "a", user: "owner", ...extra },
        ...(body !== undefined
          ? {
              body:
                typeof body === "string" || body instanceof Uint8Array
                  ? body
                  : JSON.stringify(body),
            }
          : {}),
      });
      if (r.headers.get("Content-Type") === "application/octet-stream") {
        assert.equal(r.status, expected);
        return Buffer.from(await r.arrayBuffer());
      }
      const raw = await r.text();
      assert.equal(r.status, expected, raw);
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };
    await call("/seed");
    await call("/seed", "GET", undefined, { workspace: "b" });
    const base = "/api/databases/db/backups";
    await call(base, "POST", {}, { user: "" }, 403);
    await call(base + "/policy", "PUT", { enabled: true, keep: 0 }, {}, 400);
    await call(base + "/policy", "PUT", { enabled: true, keep: 1 });
    await call("/tick");
    await call("/tick");
    let inspect = await call("/inspect");
    assert.equal(inspect.backups.length, 1);
    assert.equal(inspect.jobs.length, 1);
    let b = inspect.backups[0],
      job = inspect.jobs[0];
    const transfer = job.TaskGroups[0].Tasks.find((t) => t.Name === "transfer"),
      auth = { user: "", Authorization: "Bearer " + transfer.Env.BACKUP_TOKEN };
    // Nomad interpolates Docker config before the shell runs. Shell parameter
    // expansion such as ${digest%% *} fails Nomad's expression parser.
    assert.doesNotMatch(transfer.Config.args.join(" "), /\$\{/);
    const url = new URL(transfer.Env.BACKUP_URL).pathname;
    const bytes = dump,
      digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Buffer.from(digest).toString("hex");
    await call(
      url,
      "PUT",
      bytes,
      {
        ...auth,
        workspace: "b",
        "content-length": String(bytes.length),
        "x-backup-sha256": hex,
      },
      404,
    );
    await call(
      url,
      "PUT",
      bytes,
      { ...auth, Authorization: "Bearer wrong" },
      403,
    );
    await call(
      url,
      "PUT",
      bytes,
      {
        ...auth,
        "content-length": String(bytes.length),
        "x-backup-sha256": "0".repeat(64),
      },
      500,
    );
    await call(url, "PUT", bytes, {
      ...auth,
      "content-length": String(bytes.length),
      "x-backup-sha256": hex,
    });
    await call(url, "PUT", bytes, {
      ...auth,
      "content-length": String(bytes.length),
      "x-backup-sha256": hex,
    });
    assert(
      !JSON.stringify(await call(base)).includes(transfer.Env.BACKUP_TOKEN),
    );
    await call("/forget_checksum");
    await call(url, "PUT", bytes, {
      ...auth,
      "content-length": String(bytes.length),
      "x-backup-sha256": hex,
    });
    await call("/complete", "POST", { id: b.job_id });
    await call("/tick");
    let list = await call(base);
    assert.equal(list.backups[0].status, "succeeded");
    assert.equal(list.backups[0].checksum, hex);
    await call(
      url,
      "PUT",
      bytes,
      {
        ...auth,
        "content-length": String(bytes.length),
        "x-backup-sha256": hex,
      },
      409,
    );
    const restored = await call(
      base + "/" + b.id + "/restore",
      "POST",
      { name: "Restored copy" },
      {},
      202,
    );
    assert.notEqual(restored.target_database_id, "db");
    await call("/tick");
    inspect = await call("/inspect");
    assert.equal(inspect.databases.length, 2);
    await call(
      `/api/databases/${restored.target_database_id}/connection`,
      "GET",
      undefined,
      {},
      409,
    );
    await call("/api/databases/db", "DELETE", undefined, {}, 409);
    assert.equal(inspect.databases.find((d) => d.id === "db").name, "Fixture");
    await call("/healthy", "POST", { id: restored.target_database_id });
    await call("/tick");
    inspect = await call("/inspect");
    const restoreJob = inspect.jobs.find(
        (j) => j.ID === "pc-backup-" + restored.id,
      ),
      download = restoreJob.TaskGroups[0].Tasks[0];
    const downloaded = await call(
      new URL(download.Env.BACKUP_URL).pathname,
      "GET",
      undefined,
      { user: "", Authorization: "Bearer " + download.Env.BACKUP_TOKEN },
    );
    assert.deepEqual(downloaded, bytes);
    if (container) {
      execFileSync("docker", [
        "exec",
        container,
        "createdb",
        "-U",
        "postgres",
        "restored",
      ]);
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          container,
          "pg_restore",
          "-U",
          "postgres",
          "--exit-on-error",
          "--single-transaction",
          "--no-owner",
          "--no-acl",
          "--dbname=restored",
        ],
        { input: downloaded },
      );
      const value = execFileSync(
        "docker",
        [
          "exec",
          container,
          "psql",
          "-U",
          "postgres",
          "-d",
          "restored",
          "-tAc",
          "SELECT value FROM backup_marker WHERE id=1",
        ],
        { encoding: "utf8" },
      ).trim();
      assert.equal(value, "preserved across R2 restore");
      console.log(
        "PASS actual PostgreSQL17 dump -> private workerd R2 -> new database restore -> persisted marker",
      );
    }
    await call("/complete", "POST", { id: restoreJob.ID });
    await call("/tick");
    assert.equal(
      (await call(base)).backups.find((x) => x.id === restored.id).status,
      "succeeded",
    );
    assert.equal(
      (await call("/inspect")).databases.find((d) => d.id === "db").status,
      "healthy",
    );
    await call(base + "/" + b.id, "DELETE", undefined, {}, 202);
    await call(
      base + "/" + b.id + "/restore",
      "POST",
      { name: "too late" },
      {},
      409,
    );
    await call("/tick");
    assert.equal(
      (await call(base)).backups.find((x) => x.id === b.id).status,
      "expired",
    );
    await call("/failed_empty");
    await call(base + "/empty", "DELETE", undefined, {}, 202);
    await call("/tick");
    assert.equal(
      (await call(base)).backups.find((x) => x.id === "empty").status,
      "expired",
    );
    await call("/tick");
    assert(
      (await call("/alarm")).delay > 3600000,
      "Idle daily policy should schedule near its due time",
    );
  } finally {
    await mf.dispose();
    if (container)
      execFileSync("docker", ["rm", "-f", container], { stdio: "pipe" });
  }
});
test("outer Worker preserves large binary backup uploads before workspace routing", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `import api from './src/index';export default {fetch(r){return api.fetch(r,{PUBLIC_URL:'https://local.test',DIRECTORY:{prepare(){return{bind(){return{async first(){return{workspace_id:'a'}}}}}}},WORKSPACES:{getByName(){return{fetch(request){return new Response(request.body)}}}}})}}`;
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    loader: { ".sh": "text" },
    write: false,
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-09-15",
      compatibilityFlags: ["nodejs_compat"],
    }),
  );
  try {
    const bytes = new Uint8Array(3 * 1024 * 1024).fill(255);
    bytes[5] = 0;
    const r = await mf.dispatchFetch(
      "https://local.test/api/agent/m/database-backups/b/data",
      { method: "PUT", body: bytes },
    );
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
    const apple = await mf.dispatchFetch(
      "https://local.test/api/agent/m/apple-jobs/j/artifact",
      { method: "PUT", body: bytes },
    );
    assert.equal(apple.status, 200);
    assert.deepEqual(new Uint8Array(await apple.arrayBuffer()), bytes);
  } finally {
    await mf.dispose();
  }
});
