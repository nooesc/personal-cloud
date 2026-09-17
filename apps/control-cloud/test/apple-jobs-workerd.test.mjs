import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  wr = createRequire(require.resolve("wrangler/package.json"));
const { build } = wr("esbuild"),
  { Miniflare, convertV4MiniflareOptions } = wr("miniflare");
test("Apple Nomad jobs use real SQLite/R2, validate allocations, observe completion and keep artifacts workspace-private", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entry = `import {DurableObject} from 'cloudflare:workers'; import {SqlStore} from './src/store'; import {handleAppleJobs} from './src/apple-jobs'; import {reconcileAppleJobs} from './src/apple-nomad'; import {sha256} from './src/crypto';
const node={ID:'node',Datacenter:'dc1',Status:'ready',SchedulingEligibility:'eligible',Attributes:{'kernel.name':'darwin'},Drivers:{raw_exec:{Healthy:true}},Meta:{pc_machine_id:'m',pc_apple:'true',pc_apple_agent:'/agent',pc_apple_state:'/state',pc_apple_work:'/work'}};
export class TestWorkspace extends DurableObject {constructor(s,e){super(s,e);this.store=new SqlStore(s.storage)} async fetch(r){const w=r.headers.get('workspace'),s=this.store,path=new URL(r.url).pathname;
const requestNomad=async(method,p,payload)=>{if(p==='/v1/nodes')return [{ID:'node'}];if(p==='/v1/node/node')return node;if(p==='/v1/jobs'){s.put('nomad',payload.Job.ID,payload.Job);return {}};if(p.startsWith('/v1/allocation/'))return s.get('allocations',p.split('/').pop());const id=p.split('/')[3];if(p.endsWith('/allocations'))return s.list('allocations').filter(a=>a.JobID===id);if(method==='DELETE'){s.delete('nomad',id);return {}};const j=s.get('nomad',id);if(!j)throw Object.assign(new Error('missing'),{status:404});return j;};
const ctx={store:s,env:{...this.env,PUBLIC_URL:'https://local.test'},workspaceId:w,userId:r.headers.get('user'),requestNomad,async schedule(){},broadcast(){},event(){}};
if(path==='/seed'){s.put('projects','p',{id:'p',repository:'owner/app'});s.put('machines','m',{id:'m',credential_hash:await sha256('local-machine-token'),last_seen:new Date().toISOString(),report:{nomad:true,apple:{enabled:true,xcode:'Fixture',simulators:[{id:'sim'}]}}});return Response.json({ok:true})}
if(path==='/tick'){await reconcileAppleJobs(ctx);return Response.json(s.list('nomad'))}
if(path==='/allocation'){const a=await r.json();s.put('allocations',a.ID,a);return Response.json({ok:true})}
try{return await handleAppleJobs(r,ctx)}catch(e){return Response.json({error:e.message},{status:e.status||500})}}}
export default {fetch(r,e){return e.WORKSPACES.getByName(r.headers.get('workspace')).fetch(r)}}`;
  const bundle = await build({
    stdin: { contents: entry, resolveDir: root },
    bundle: true,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers"],
    write: false,
    plugins: [
      {
        name: "local-github-fixture",
        setup(b) {
          b.onLoad({ filter: /\/github\.ts$/ }, () => ({
            contents: `export async function sourceToken(){return 'local-scoped-source-token'};export async function githubRequest(t,p){return {sha:p.split('/').pop()}}`,
            loader: "ts",
          }));
        },
      },
    ],
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
    }),
  );
  try {
    const call = async (
      path,
      method = "GET",
      body,
      extra = {},
      expected = 200,
    ) => {
      const r = await mf.dispatchFetch("https://local.test" + path, {
        method,
        headers: {
          workspace: "a",
          user: "owner",
          "Content-Type": "application/json",
          ...extra,
        },
        ...(body
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      });
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
    const p = "/api/projects/p/apple-jobs",
      spec = {
        machine_id: "m",
        scheme: "App",
        container: "App.xcodeproj",
        commit: "a".repeat(40),
        action: "test",
        simulator: "sim",
      };
    const j = await call(p, "POST", spec, {}, 201);
    const second = await call(p, "POST", spec, {}, 201);
    const agent = { user: "", Authorization: "Bearer local-machine-token" };
    await call("/api/agent/m/apple-jobs", "POST", {}, agent, 410);
    const registered = await call("/tick");
    const nomad = registered.find((n) => n.ID === j.nomad_job_id);
    assert.equal(nomad.TaskGroups[0].Tasks[0].Driver, "raw_exec");
    const attempt = nomad.TaskGroups[0].Tasks[0].Config.args.at(-1);
    const allocation = {
      ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      JobID: j.nomad_job_id,
      NodeID: "node",
      DesiredStatus: "run",
      ClientStatus: "running",
    };
    const url = "/api/agent/m/apple-jobs/" + j.id,
      auth = { ...agent, "x-apple-attempt": attempt };
    await call("/allocation", "POST", { ...allocation, NodeID: "foreign" });
    await call(
      url + "/start",
      "POST",
      { allocation_id: allocation.ID },
      auth,
      403,
    );
    await call("/allocation", "POST", allocation);
    const claimed = await call(
      url + "/start",
      "POST",
      { allocation_id: allocation.ID },
      auth,
    );
    assert.equal(claimed.job.source_token, "local-scoped-source-token");
    await call(
      url,
      "POST",
      { status: "succeeded", log: "ok" },
      { ...auth, "x-apple-attempt": "wrong" },
      403,
    );
    await call(url + "/artifact", "PUT", "zip bytes", {
      ...auth,
      "content-length": "9",
    });
    await call(
      url,
      "POST",
      { status: "succeeded", log: "actual worker result" },
      auth,
    );
    assert.equal(await call(p + "/" + j.id + "/artifact"), "zip bytes");
    await call(
      p + "/" + j.id + "/artifact",
      "GET",
      undefined,
      { workspace: "b" },
      404,
    );
    assert.equal(
      (await call(p)).jobs.find((x) => x.id === j.id).status,
      "running",
    );
    await call("/allocation", "POST", {
      ...allocation,
      ClientStatus: "complete",
    });
    await call("/tick");
    const list = await call(p);
    assert.equal(list.jobs.find((x) => x.id === j.id).status, "succeeded");
    assert(!JSON.stringify(list).includes("local-scoped"));
    assert(!JSON.stringify(list).includes(claimed.job.attempt));
    await call(p + "/" + second.id, "DELETE");
    await call("/tick");
    await call(url, "POST", { status: "failed", log: "stale" }, auth, 409);
  } finally {
    await mf.dispose();
  }
});
