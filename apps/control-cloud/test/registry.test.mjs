import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
// Run the production class against a deterministic storage/R2 adapter to force races
// that are impractical to time reliably over HTTP. Live local workerd checks below
// remain separate and opt in with REGISTRY_TEST_URL.
const transpile = (source) =>
  stripTypeScriptTypes(source, { mode: "transform" });
const dataModule = (source) =>
  "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const core = dataModule(
  transpile(await readFile(new URL("../src/core.ts", import.meta.url), "utf8")),
);
const crypt = dataModule(
  transpile(
    await readFile(new URL("../src/crypto.ts", import.meta.url), "utf8"),
  ).replace(/from ['"]\.\/core['"]/g, `from '${core}'`),
);
let source = transpile(
  await readFile(new URL("../src/registry.ts", import.meta.url), "utf8"),
);
source = source
  .replace(
    /import \{ DurableObject \} from ['"]cloudflare:workers['"];?/,
    "class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
  )
  .replace(/from ['"]\.\/core['"]/g, `from '${core}'`)
  .replace(/from ['"]\.\/crypto['"]/g, `from '${crypt}'`);
const { RegistryUpload, blobRange } = await import(dataModule(source));
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(length) {
    let count = 0;
    super({
      transform(chunk, controller) {
        count += chunk.byteLength;
        if (count > length) throw Error("length overflow");
        controller.enqueue(chunk);
      },
      flush() {
        if (count !== length) throw Error("length mismatch");
      },
    });
  }
};
const wid = "11111111-1111-4111-8111-111111111111",
  uid = "22222222-2222-4222-8222-222222222222",
  name = `personal-cloud/${wid}/service`;
const headers = {
  "x-pc-workspace-id": wid,
  "x-pc-upload-id": uid,
  "x-pc-repository": name,
};
function fixture() {
  const state = new Map(),
    objects = new Map();
  let tail = Promise.resolve();
  const storage = {
    get: async (key) => structuredClone(state.get(key)),
    put: async (key, value) => state.set(key, structuredClone(value)),
    setAlarm: async () => {},
    deleteAll: async () => state.clear(),
    transaction: async (callback) => {
      const run = tail.then(() => callback(storage));
      tail = run.catch(() => {});
      return run;
    },
  };
  const r2 = {
    put: async (key, value) => {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, bytes);
      return { size: bytes.length };
    },
    get: async (key) => {
      const bytes = objects.get(key);
      return bytes
        ? { size: bytes.length, body: new Blob([bytes]).stream() }
        : null;
    },
    delete: async (key) => {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k);
    },
    list: async ({ prefix }) => ({
      objects: [...objects.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    }),
  };
  const upload = new RegistryUpload({ storage }, { ARTIFACTS: r2 });
  const request = (method, body, extra = {}, query = "") =>
    new Request(`https://local/v2/${name}/blobs/uploads/${uid}${query}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined
          ? {}
          : { "Content-Length": String(Buffer.byteLength(body)) }),
        ...extra,
      },
      body,
    });
  const init = () =>
    upload.fetch(
      new Request("https://local/init", { method: "POST", headers }),
    );
  return { upload, storage, objects, r2, request, init };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
const sha = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
test("blob byte ranges normalize suffix, open-ended and clamped ranges", () => {
  assert.deepEqual(blobRange("bytes=-3", 10), { offset: 7, length: 3 });
  assert.deepEqual(blobRange("bytes=2-", 10), { offset: 2, length: 8 });
  assert.deepEqual(blobRange("bytes=2-100", 10), { offset: 2, length: 8 });
  for (const range of [
    "bytes=-0",
    "bytes=10-",
    "bytes=5-2",
    "bytes=0-1,5-6",
    "bytes=-",
    "invalid",
  ])
    assert.equal(blobRange(range, 10), undefined);
});
test("stolen PATCH lease cannot commit bytes or overwrite a later request state", async () => {
  const f = fixture();
  await f.init();
  const waiting = deferred(),
    release = deferred(),
    put = f.r2.put;
  let first = true;
  f.r2.put = async (...args) => {
    const result = await put(...args);
    if (first) {
      first = false;
      waiting.resolve();
      await release.promise;
    }
    return result;
  };
  const stale = f.upload.fetch(
    f.request("PATCH", "old", { "Content-Range": "0-2" }),
  );
  await waiting.promise;
  const observed = await f.upload.fetch(f.request("GET"));
  assert.equal(observed.status, 204);
  assert.equal(observed.headers.get("Range"), "0-0");
  const state = await f.storage.get("upload");
  state.operation.expires = Date.now() - 1;
  await f.storage.put("upload", state);
  const newer = await f.upload.fetch(
    f.request("PATCH", "new", { "Content-Range": "0-2" }),
  );
  assert.equal(newer.status, 202);
  const committed = await f.storage.get("upload");
  release.resolve();
  assert.equal((await stale).status, 409);
  assert.deepEqual(await f.storage.get("upload"), committed);
  assert.equal(f.objects.size, 1);
  assert.equal(new TextDecoder().decode([...f.objects.values()][0]), "new");
});
test("stale finalization cannot overwrite the winner or remove its verified blob", async () => {
  const f = fixture();
  await f.init();
  await f.upload.fetch(f.request("PATCH", "abc"));
  const waiting = deferred(),
    release = deferred(),
    put = f.r2.put;
  let first = true;
  f.r2.put = async (key, value) => {
    const result = await put(key, value);
    if (first && key.endsWith("/assembled")) {
      first = false;
      waiting.resolve();
      await release.promise;
    }
    return result;
  };
  const stale = f.upload.fetch(
    f.request("PUT", "", {}, `?digest=${sha("abc")}`),
  );
  await waiting.promise;
  const state = await f.storage.get("upload");
  state.operation.expires = Date.now() - 1;
  await f.storage.put("upload", state);
  assert.equal(
    (await f.upload.fetch(f.request("PUT", "", {}, `?digest=${sha("abc")}`)))
      .status,
    201,
  );
  const completed = await f.storage.get("upload");
  release.resolve();
  assert.equal((await stale).status, 409);
  assert.deepEqual(await f.storage.get("upload"), completed);
  assert.equal(completed.completed, sha("abc"));
  assert.equal(
    new TextDecoder().decode(
      f.objects.get(`registry/${wid}/blobs/${sha("abc")}`),
    ),
    "abc",
  );
});
test("lost PATCH reply is recovered by GET offset and duplicate range is rejected", async () => {
  const f = fixture();
  await f.init();
  assert.equal(
    (
      await f.upload.fetch(
        f.request("PATCH", "abc", { "Content-Range": "0-2" }),
      )
    ).status,
    202,
  );
  assert.equal(
    (await f.upload.fetch(f.request("GET"))).headers.get("Range"),
    "0-2",
  );
  assert.equal(
    (
      await f.upload.fetch(
        f.request("PATCH", "abc", { "Content-Range": "0-2" }),
      )
    ).status,
    416,
  );
  assert.equal((await f.storage.get("upload")).size, 3);
});
test("digest mismatch preserves resumable bytes; finalization replay returns the original digest", async () => {
  const f = fixture();
  await f.init();
  await f.upload.fetch(f.request("PATCH", "abc"));
  assert.equal(
    (await f.upload.fetch(f.request("PUT", "", {}, `?digest=${sha("wrong")}`)))
      .status,
    400,
  );
  assert.equal((await f.storage.get("upload")).size, 3);
  const first = await f.upload.fetch(
    f.request("PUT", "", {}, `?digest=${sha("abc")}`),
  );
  assert.equal(first.status, 201);
  const repeated = await f.upload.fetch(
    f.request("PUT", "abc", {}, `?digest=${sha("abc")}`),
  );
  assert.equal(repeated.status, 201);
  assert.equal(repeated.headers.get("Docker-Content-Digest"), sha("abc"));
  assert.equal(
    [...f.objects.keys()].some((key) => key.includes("/uploads/")),
    false,
  );
});
test("unknown body length is explicitly rejected and zero-byte blobs finalize", async () => {
  const f = fixture();
  await f.init();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  assert.equal(
    (
      await f.upload.fetch(
        new Request(`https://local/v2/${name}/blobs/uploads/${uid}`, {
          method: "PATCH",
          headers,
          body: stream,
          duplex: "half",
        }),
      )
    ).status,
    411,
  );
  assert.equal(
    (await f.upload.fetch(f.request("PUT", "", {}, `?digest=${sha("")}`)))
      .status,
    201,
  );
});
test("expiry cleanup removes uncommitted orphan parts only within the upload namespace", async () => {
  const f = fixture();
  await f.init();
  const prefix = `registry/${wid}/uploads/${uid}/`;
  f.objects.set(prefix + "interrupted-op/part", new Uint8Array([1]));
  f.objects.set(`registry/${wid}/blobs/keep`, new Uint8Array([2]));
  const state = await f.storage.get("upload");
  state.updated = Date.now() - 86400001;
  await f.storage.put("upload", state);
  await f.upload.alarm();
  assert.equal(await f.storage.get("upload"), undefined);
  assert.deepEqual([...f.objects.keys()], [`registry/${wid}/blobs/keep`]);
});

test(
  "actual local workerd supports registry retries, ranges and monolithic uploads",
  { skip: !process.env.REGISTRY_TEST_URL },
  async () => {
    const base = new URL(process.env.REGISTRY_TEST_URL);
    assert.ok(["localhost", "127.0.0.1"].includes(base.hostname));
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../work/hosted-local-users.json", import.meta.url),
        "utf8",
      ),
    );
    const credential = await fetch(new URL("/api/registry/credentials", base), {
      method: "POST",
      headers: {
        Origin: "http://localhost:4320",
        Cookie: "pc_hosted_session=" + fixture.users[0].token,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(credential.status, 200);
    const registry = await credential.json();
    const auth = {
      Authorization:
        "Basic " +
        Buffer.from(
          registry.registry_username + ":" + registry.registry_password,
        ).toString("base64"),
    };
    const name = registry.repository_prefix + "/" + fixture.service.id,
      payload = "resumable-local-bytes",
      digest = sha(payload);
    let response = await fetch(new URL(`/v2/${name}/blobs/uploads/`, base), {
      method: "POST",
      headers: auth,
    });
    assert.equal(response.status, 202);
    const location = response.headers.get("Location");
    response = await fetch(new URL(location, base), {
      method: "PATCH",
      headers: { ...auth, "Content-Range": `0-${payload.length - 1}` },
      body: payload,
    });
    assert.equal(response.status, 202);
    response = await fetch(new URL(location, base), { headers: auth });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Range"), `0-${payload.length - 1}`);
    response = await fetch(new URL(location, base), {
      method: "PATCH",
      headers: { ...auth, "Content-Range": `0-${payload.length - 1}` },
      body: payload,
    });
    assert.equal(response.status, 416);
    for (let i = 0; i < 2; i++) {
      response = await fetch(new URL(location + "?digest=" + digest, base), {
        method: "PUT",
        headers: auth,
      });
      assert.equal(response.status, 201);
    }
    response = await fetch(new URL(`/v2/${name}/blobs/${digest}`, base), {
      headers: { ...auth, Range: "bytes=-5" },
    });
    assert.equal(response.status, 206);
    assert.equal(await response.text(), payload.slice(-5));
    assert.equal(
      response.headers.get("Content-Range"),
      `bytes ${payload.length - 5}-${payload.length - 1}/${payload.length}`,
    );
    response = await fetch(new URL(`/v2/${name}/blobs/${digest}`, base), {
      headers: { ...auth, Range: "bytes=999-" },
    });
    assert.equal(response.status, 416);
    response = await fetch(
      new URL(`/v2/${name}/blobs/uploads/?digest=${sha("monolithic")}`, base),
      { method: "POST", headers: auth, body: "monolithic" },
    );
    assert.equal(response.status, 201);
    response = await fetch(
      new URL(`/v2/${name}/blobs/uploads/?digest=${sha("")}`, base),
      { method: "POST", headers: auth },
    );
    assert.equal(response.status, 201);
  },
);
