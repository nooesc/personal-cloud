import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import type { Env } from "./env";
import { boundedText, body, fail, HttpError, id, json } from "./core";
import { sha256 } from "./crypto";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
function registryResponse(
  body: BodyInit | null,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(body, {
    status,
    headers: { "Docker-Distribution-Api-Version": "registry/2.0", ...headers },
  });
}
function uploadLocation(name: string, upload: string): string {
  return `/v2/${name}/blobs/uploads/${upload}`;
}
export function blobRange(
  header: string,
  size: number,
): { offset: number; length: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size <= 0) return undefined;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return undefined;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return undefined;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
export async function handleRegistry(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authorization = request.headers.get("Authorization");
    if (!authorization?.startsWith("Basic "))
      return registryResponse(null, 401, {
        "WWW-Authenticate": 'Basic realm="dinghy images"',
      });
    let login: string;
    try {
      login = atob(authorization.slice(6));
    } catch {
      return registryResponse(null, 401);
    }
    const separator = login.indexOf(":"),
      workspaceId = login.slice(0, separator),
      secret = login.slice(separator + 1);
    if (!/^[a-f0-9-]{36}$/.test(workspaceId) || secret.length < 32)
      return registryResponse(null, 401);
    const auth = await env.WORKSPACES.getByName(workspaceId).fetch(
      new Request("https://workspace.internal/internal/registry/authorize", {
        method: "POST",
        headers: {
          "x-pc-workspace-id": workspaceId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hash: await sha256(secret) }),
      }),
    );
    if (!auth.ok)
      return registryResponse(null, 401, {
        "WWW-Authenticate": 'Basic realm="dinghy images"',
      });
    const url = new URL(request.url),
      path = decodeURIComponent(url.pathname);
    if (path === "/v2/" || path === "/v2")
      return registryResponse("{}", 200, {
        "Content-Type": "application/json",
      });
    const match = path.match(/^\/v2\/(.+)\/(manifests|blobs|tags)\/(.*)$/);
    if (!match) fail(404, "Registry path not found");
    const [, name, kind, reference] = match;
    if (
      !name.startsWith(`personal-cloud/${workspaceId}/`) ||
      !/^personal-cloud\/[a-f0-9-]{36}\/[a-zA-Z0-9_.-]+$/.test(name)
    )
      fail(403, "Repository belongs to another workspace");
    const prefix = `registry/${workspaceId}`,
      repo = `${prefix}/repositories/${name.split("/")[2]}`;
    if (
      kind === "blobs" &&
      (reference === "uploads" || reference.startsWith("uploads/"))
    ) {
      if (
        (reference === "uploads/" || reference === "uploads") &&
        request.method === "POST"
      ) {
        const mount = url.searchParams.get("mount");
        if (
          mount &&
          digestPattern.test(mount) &&
          (await env.ARTIFACTS.head(`${prefix}/blobs/${mount}`))
        )
          return registryResponse(null, 201, {
            Location: `/v2/${name}/blobs/${mount}`,
            "Docker-Content-Digest": mount,
          });
        const upload = id(),
          headers = new Headers({
            "x-pc-workspace-id": workspaceId,
            "x-pc-repository": name,
            "x-pc-upload-id": upload,
          });
        const stub = env.UPLOADS.getByName(`${workspaceId}/${upload}`);
        const initialized = await stub.fetch(
          new Request("https://upload.internal/init", {
            method: "POST",
            headers,
          }),
        );
        if (!initialized.ok) return initialized;
        const digest = url.searchParams.get("digest");
        if (
          digest ||
          (request.body && request.headers.get("Content-Length") !== "0")
        ) {
          const forwarded = new Headers(request.headers);
          forwarded.delete("Authorization");
          for (const [key, value] of headers) forwarded.set(key, value);
          const target = new URL(uploadLocation(name, upload), request.url);
          if (digest) target.searchParams.set("digest", digest);
          return stub.fetch(
            new Request(target, {
              method: digest ? "PUT" : "PATCH",
              headers: forwarded,
              body: request.body,
            }),
          );
        }
        return registryResponse(null, 202, {
          Location: uploadLocation(name, upload),
          "Docker-Upload-UUID": upload,
          Range: "0-0",
          "Content-Length": "0",
        });
      }
      const upload = reference.split("/")[1];
      if (
        reference.split("/").length !== 2 ||
        !upload ||
        !/^[a-f0-9-]{36}$/.test(upload)
      )
        fail(404, "Upload not found");
      const headers = new Headers(request.headers);
      headers.delete("Authorization");
      headers.set("x-pc-workspace-id", workspaceId);
      headers.set("x-pc-repository", name);
      headers.set("x-pc-upload-id", upload);
      return env.UPLOADS.getByName(`${workspaceId}/${upload}`).fetch(
        new Request(request, { headers }),
      );
    }
    if (kind === "blobs") {
      if (!digestPattern.test(reference)) fail(400, "Invalid digest");
      if (!["GET", "HEAD"].includes(request.method))
        fail(405, "Method not allowed");
      const key = `${prefix}/blobs/${reference}`;
      if (request.method === "HEAD") {
        const object = await env.ARTIFACTS.head(key);
        if (!object) fail(404, "Blob unknown");
        return registryResponse(null, 200, {
          "Content-Length": String(object.size),
          "Docker-Content-Digest": reference,
          "Content-Type": "application/octet-stream",
          "Accept-Ranges": "bytes",
        });
      }
      const range = request.headers.get("Range");
      let selected: { offset: number; length: number } | undefined;
      if (range) {
        const info = await env.ARTIFACTS.head(key);
        if (!info) fail(404, "Blob unknown");
        selected = blobRange(range, info.size);
        if (!selected)
          return registryResponse(null, 416, {
            "Content-Range": `bytes */${info.size}`,
            "Content-Length": "0",
            "Accept-Ranges": "bytes",
          });
      }
      const object = await env.ARTIFACTS.get(
        key,
        selected ? { range: selected } : undefined,
      );
      if (!object) fail(404, "Blob unknown");
      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
        "Docker-Content-Digest": reference,
        "Content-Length": String(selected?.length ?? object.size),
        "Accept-Ranges": "bytes",
      };
      if (selected)
        headers["Content-Range"] =
          `bytes ${selected.offset}-${selected.offset + selected.length - 1}/${object.size}`;
      return registryResponse(object.body, selected ? 206 : 200, headers);
    }
    if (kind === "manifests") {
      if (
        !digestPattern.test(reference) &&
        !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(reference)
      )
        fail(400, "Invalid manifest reference");
      if (request.method === "PUT") {
        const raw = await boundedText(request);
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          fail(400, "Invalid manifest");
        }
        if (!data || typeof data !== "object" || data.schemaVersion !== 2)
          fail(400, "Unsupported manifest version");
        const mediaType = (
          request.headers.get("Content-Type") ||
          data.mediaType ||
          "application/vnd.oci.image.manifest.v1+json"
        )
          .split(";")[0]
          .trim();
        if (
          ![
            "application/vnd.oci.image.manifest.v1+json",
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.v2+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
          ].includes(mediaType)
        )
          fail(400, "Unsupported manifest media type");
        const index =
          mediaType.includes("index") || mediaType.includes("manifest.list");
        if (
          index
            ? !Array.isArray(data.manifests) || data.manifests.length > 1000
            : !data.config ||
              !Array.isArray(data.layers) ||
              data.layers.length > 1000
        )
          fail(400, "Invalid manifest descriptors");
        const descriptors = index
          ? data.manifests
          : [data.config, ...data.layers];
        for (const descriptor of descriptors) {
          if (
            !descriptor ||
            !digestPattern.test(descriptor.digest) ||
            !Number.isSafeInteger(descriptor.size) ||
            descriptor.size < 0
          )
            fail(400, "Invalid manifest descriptor");
          const referenced = await env.ARTIFACTS.head(
            index
              ? `${repo}/manifests/${descriptor.digest}`
              : `${prefix}/blobs/${descriptor.digest}`,
          );
          if (!referenced || referenced.size !== descriptor.size)
            fail(
              400,
              "Manifest references missing or incorrectly sized content",
            );
        }
        const digest = `sha256:${await sha256(raw)}`;
        if (digestPattern.test(reference) && reference !== digest)
          fail(400, "Manifest digest mismatch");
        const options = {
          httpMetadata: { contentType: mediaType },
          customMetadata: { digest },
        };
        await env.ARTIFACTS.put(`${repo}/manifests/${digest}`, raw, options);
        if (reference !== digest)
          await env.ARTIFACTS.put(
            `${repo}/manifests/${reference}`,
            raw,
            options,
          );
        return registryResponse(null, 201, {
          Location: `/v2/${name}/manifests/${digest}`,
          "Docker-Content-Digest": digest,
        });
      }
      if (["GET", "HEAD"].includes(request.method)) {
        const object = await env.ARTIFACTS.get(
          `${repo}/manifests/${reference}`,
        );
        if (!object) fail(404, "Manifest unknown");
        return registryResponse(
          request.method === "HEAD" ? null : object.body,
          200,
          {
            "Content-Type":
              object.httpMetadata?.contentType ||
              "application/vnd.oci.image.manifest.v1+json",
            "Content-Length": String(object.size),
            "Docker-Content-Digest": object.customMetadata?.digest || reference,
          },
        );
      }
      fail(405, "Method not allowed");
    }
    if (kind === "tags" && reference === "list" && request.method === "GET") {
      const listed = await env.ARTIFACTS.list({
        prefix: `${repo}/manifests/`,
        limit: 1000,
      });
      return registryResponse(
        JSON.stringify({
          name,
          tags: listed.objects
            .map((o) => o.key.split("/").pop())
            .filter((t) => t && !t.startsWith("sha256:")),
        }),
        200,
        { "Content-Type": "application/json" },
      );
    }
    fail(404, "Registry path not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return registryResponse(
      JSON.stringify({
        errors: [
          {
            code:
              status === 401
                ? "UNAUTHORIZED"
                : status === 404
                  ? "NAME_UNKNOWN"
                  : "UNKNOWN",
            message:
              error instanceof HttpError
                ? error.message
                : "Registry operation failed",
          },
        ],
      }),
      status,
      { "Content-Type": "application/json" },
    );
  }
}

type Upload = {
  workspaceId: string;
  name: string;
  id: string;
  chunks: { key: string; size: number }[];
  size: number;
  updated: number;
  operation?: { id: string; expires: number };
  completed?: string;
  cancelled?: boolean;
};
const LEASE_MS = 120000,
  UPLOAD_TTL_MS = 86400000,
  MAX_CHUNK = 100 * 1024 * 1024,
  MAX_BLOB = 5 * 1024 * 1024 * 1024;
function uploadHeaders(state: Upload): Record<string, string> {
  return {
    Location: uploadLocation(state.name, state.id),
    "Docker-Upload-UUID": state.id,
    Range: `0-${Math.max(0, state.size - 1)}`,
    "Content-Length": "0",
  };
}
function uploadComplete(state: Upload): Response {
  return registryResponse(null, 201, {
    Location: `/v2/${state.name}/blobs/${state.completed}`,
    "Docker-Content-Digest": state.completed!,
    "Content-Length": "0",
  });
}
function uploadFailure(error: unknown, state?: Upload): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const headers = state ? uploadHeaders(state) : {};
  delete headers["Content-Length"];
  const code =
    error instanceof HttpError &&
    error.message.startsWith("Blob digest mismatch")
      ? "DIGEST_INVALID"
      : status === 411
        ? "SIZE_INVALID"
        : status === 416
          ? "RANGE_INVALID"
          : status === 404
            ? "BLOB_UPLOAD_UNKNOWN"
            : status === 400
              ? "BLOB_UPLOAD_INVALID"
              : "UNKNOWN";
  return registryResponse(
    JSON.stringify({
      errors: [
        {
          code,
          message:
            error instanceof HttpError
              ? error.message
              : "Registry upload failed; query the upload offset before retrying",
        },
      ],
    }),
    status,
    {
      ...headers,
      "Content-Type": "application/json",
      ...(status === 409 ? { "Retry-After": "2" } : {}),
    },
  );
}
export class RegistryUpload extends DurableObject<Env> {
  private async updateOwned(
    operation: string,
    change?: (state: Upload) => void,
  ): Promise<Upload> {
    return this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Upload>("upload");
      if (
        !current ||
        current.operation?.id !== operation ||
        current.cancelled ||
        current.completed
      )
        fail(409, "Upload operation was superseded; query the current offset");
      if (change) change(current);
      current.updated = Date.now();
      if (current.operation) current.operation.expires = Date.now() + LEASE_MS;
      await tx.put("upload", current);
      await tx.setAlarm(current.updated + UPLOAD_TTL_MS);
      return current;
    });
  }
  private async removePrefix(state: Upload): Promise<void> {
    // List the entire upload namespace: a crash can leave parts not yet in the committed chunk list.
    const prefix = `registry/${state.workspaceId}/uploads/${state.id}/`;
    let cursor: string | undefined;
    do {
      const result = await this.env.ARTIFACTS.list({
        prefix,
        limit: 1000,
        cursor,
      });
      if (result.objects.length)
        await this.env.ARTIFACTS.delete(
          result.objects.map((object) => object.key),
        );
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
  }
  async fetch(request: Request): Promise<Response> {
    const workspaceId = request.headers.get("x-pc-workspace-id")!,
      name = request.headers.get("x-pc-repository")!,
      uploadId = request.headers.get("x-pc-upload-id")!;
    let state: Upload | undefined,
      operation: string | undefined,
      partKey: string | undefined,
      tempKey: string | undefined,
      partCommitted = false;
    try {
      if (
        !/^[a-f0-9-]{36}$/.test(workspaceId) ||
        !/^[a-f0-9-]{36}$/.test(uploadId) ||
        !name?.startsWith(`personal-cloud/${workspaceId}/`)
      )
        fail(403, "Invalid internal upload identity");
      if (new URL(request.url).pathname === "/init") {
        if (request.method !== "POST") fail(405, "Method not allowed");
        await this.ctx.storage.transaction(async (tx) => {
          const existing = await tx.get<Upload>("upload");
          if (existing) {
            if (
              existing.workspaceId !== workspaceId ||
              existing.name !== name ||
              existing.id !== uploadId
            )
              fail(409, "Upload already exists");
            return;
          }
          await tx.put("upload", {
            workspaceId,
            name,
            id: uploadId,
            chunks: [],
            size: 0,
            updated: Date.now(),
          } satisfies Upload);
          await tx.setAlarm(Date.now() + UPLOAD_TTL_MS);
        });
        return json({ ok: true });
      }
      state = await this.ctx.storage.get<Upload>("upload");
      if (
        !state ||
        state.workspaceId !== workspaceId ||
        state.name !== name ||
        state.id !== uploadId ||
        state.cancelled
      )
        fail(404, "Upload not found");
      const expected = new URL(request.url).searchParams.get("digest");
      if (state.completed) {
        if (request.method === "PUT" && expected === state.completed)
          return uploadComplete(state);
        if (request.method === "GET")
          return registryResponse(null, 204, {
            ...uploadHeaders(state),
            "Docker-Content-Digest": state.completed,
          });
        fail(404, "Upload is already complete");
      }
      // GET remains readable while an upload is in flight: a lost PATCH response is recovered by its durable offset.
      if (request.method === "GET")
        return registryResponse(null, 204, uploadHeaders(state));
      if (!["PATCH", "PUT", "DELETE"].includes(request.method))
        fail(405, "Method not allowed");
      if (
        request.method === "PUT" &&
        (!expected || !digestPattern.test(expected))
      )
        fail(400, "A valid sha256 digest is required");
      const declared = request.headers.get("Content-Length");
      if (request.method !== "DELETE" && request.body && declared === null)
        fail(
          411,
          "Content-Length is required for each upload chunk; send bounded chunks",
        );
      if (declared !== null && !/^\d+$/.test(declared))
        fail(400, "Invalid Content-Length");
      const length = Number(declared ?? 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNK)
        fail(413, "Upload chunk exceeds 100 MiB");
      const range = request.headers.get("Content-Range"),
        rangeMatch = range?.match(/^(?:bytes )?(\d+)-(\d+)$/);
      if (
        range &&
        (!rangeMatch ||
          Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1 !== length)
      )
        fail(416, "Invalid upload range");
      operation = id();
      state = await this.ctx.storage.transaction(async (tx) => {
        const current = await tx.get<Upload>("upload");
        if (!current || current.completed || current.cancelled)
          fail(409, "Upload changed; query its current status");
        if (current.operation && current.operation.expires > Date.now())
          fail(409, "Another upload operation is in progress");
        if (rangeMatch && Number(rangeMatch[1]) !== current.size)
          fail(416, "Upload range does not match the committed offset");
        if (current.size + length > MAX_BLOB || current.chunks.length >= 512)
          fail(413, "Upload exceeds the supported blob size or chunk count");
        current.operation = { id: operation!, expires: Date.now() + LEASE_MS };
        current.updated = Date.now();
        await tx.put("upload", current);
        await tx.setAlarm(current.updated + UPLOAD_TTL_MS);
        return current;
      });
      if (request.method === "DELETE") {
        state = await this.updateOwned(operation, (current) => {
          current.cancelled = true;
          delete current.operation;
        });
        await this.removePrefix(state);
        return registryResponse(null, 204, { "Content-Length": "0" });
      }
      if (length > 0) {
        if (!request.body) fail(400, "Upload body is missing");
        // Each operation owns unique object names. A stale request can never overwrite a newer part.
        partKey = `registry/${workspaceId}/uploads/${uploadId}/${operation}/part`;
        const stream = new FixedLengthStream(length),
          writer = stream.writable.getWriter();
        const stored = this.env.ARTIFACTS.put(partKey, stream.readable);
        const reader = request.body.getReader();
        let bytes = 0,
          lastLease = Date.now();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > length) fail(400, "Upload body exceeds Content-Length");
            if (Date.now() - lastLease > 15000) {
              await this.updateOwned(operation);
              lastLease = Date.now();
            }
            await writer.write(value);
          }
          if (bytes !== length)
            fail(400, "Upload body does not match Content-Length");
          await writer.close();
          const saved = await stored;
          if (!saved || saved.size !== length)
            fail(400, "Stored upload size mismatch");
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          await writer.abort(error).catch(() => {});
          await stored.catch(() => {});
          throw error;
        }
        state = await this.updateOwned(operation, (current) => {
          current.chunks.push({ key: partKey!, size: length });
          current.size += length;
        });
        partCommitted = true;
      } else if (request.body) {
        const reader = request.body.getReader();
        const first = await reader.read();
        if (!first.done) {
          await reader.cancel();
          fail(400, "Nonempty upload body declared as zero bytes");
        }
      }
      if (request.method === "PATCH")
        return registryResponse(null, 202, uploadHeaders(state));
      const hash = createHash("sha256"),
        stream = new FixedLengthStream(state.size),
        writer = stream.writable.getWriter();
      tempKey = `registry/${workspaceId}/uploads/${uploadId}/${operation}/assembled`;
      const stored = this.env.ARTIFACTS.put(tempKey, stream.readable);
      let lastLease = Date.now();
      try {
        for (const chunk of state.chunks) {
          await this.updateOwned(operation);
          lastLease = Date.now();
          const object = await this.env.ARTIFACTS.get(chunk.key);
          if (!object || object.size !== chunk.size)
            throw new Error("Missing or damaged upload chunk");
          const reader = object.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            if (Date.now() - lastLease > 15000) {
              await this.updateOwned(operation);
              lastLease = Date.now();
            }
            await writer.write(value);
          }
        }
        await writer.close();
        await stored;
      } catch (error) {
        await writer.abort(error).catch(() => {});
        await stored.catch(() => {});
        throw error;
      }
      if (`sha256:${hash.digest("hex")}` !== expected)
        fail(
          400,
          "Blob digest mismatch; uploaded bytes remain available for retry or cancellation",
        );
      await this.updateOwned(operation);
      const assembled = await this.env.ARTIFACTS.get(tempKey);
      if (!assembled) throw new Error("Missing assembled upload");
      await this.env.ARTIFACTS.put(
        `registry/${workspaceId}/blobs/${expected}`,
        assembled.body,
        { httpMetadata: { contentType: "application/octet-stream" } },
      );
      // Even if publishing raced lease expiry, it only wrote verified content-addressed bytes.
      // Only the current generation may mark this upload complete or remove its shared parts.
      state = await this.updateOwned(operation, (current) => {
        current.completed = expected!;
        delete current.operation;
      });
      await this.removePrefix(state);
      return uploadComplete(state);
    } catch (error) {
      return uploadFailure(error, state);
    } finally {
      if (tempKey) await this.env.ARTIFACTS.delete(tempKey).catch(() => {});
      if (partKey && !partCommitted)
        await this.env.ARTIFACTS.delete(partKey).catch(() => {});
      if (operation)
        await this.ctx.storage.transaction(async (tx) => {
          const current = await tx.get<Upload>("upload");
          if (current && current.operation?.id === operation) {
            delete current.operation;
            current.updated = Date.now();
            await tx.put("upload", current);
            await tx.setAlarm(current.updated + UPLOAD_TTL_MS);
          }
        });
    }
  }
  async alarm(): Promise<void> {
    let state = await this.ctx.storage.get<Upload>("upload");
    if (!state) return;
    const expires = Math.max(
      state.updated + UPLOAD_TTL_MS,
      state.operation?.expires ?? 0,
    );
    if (expires > Date.now()) {
      await this.ctx.storage.setAlarm(expires);
      return;
    }
    state = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<Upload>("upload");
      if (!current) return undefined;
      if (
        Math.max(
          current.updated + UPLOAD_TTL_MS,
          current.operation?.expires ?? 0,
        ) > Date.now()
      )
        return undefined;
      current.cancelled = true;
      delete current.operation;
      await tx.put("upload", current);
      return current;
    });
    if (!state) return;
    await this.removePrefix(state);
    await this.ctx.storage.deleteAll();
  }
}
