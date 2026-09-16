import type { Env } from "./env";
// Stored documents mirror the versioned agent/API JSON protocol.
export type Doc = Record<string, any>;
export interface Store {
  get<T = Doc>(collection: string, id: string): T | undefined;
  list<T = Doc>(collection: string): T[];
  put(collection: string, id: string, value: unknown): void;
  delete(collection: string, id: string): void;
  transaction<T>(fn: () => T): T;
}
export interface WorkspaceContext {
  store: Store;
  env: Env;
  workspaceId: string;
  userId: string | null;
  machineId: string | null;
  requestNomad(
    method: string,
    path: string,
    body?: unknown,
    machineId?: string,
  ): Promise<Doc>;
  schedule(delayMs?: number): Promise<void>;
  broadcast(): void;
  event(kind: string, message: string): void;
  seal(context: string, value: string): Promise<string>;
  open(context: string, value: string): Promise<string>;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
export async function body(request: Request): Promise<Doc> {
  const text = await boundedText(request);
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "Expected an object");
    return value;
  } catch {
    return fail(400, "Invalid JSON");
  }
}
export function now(): string {
  return new Date().toISOString();
}
export function id(): string {
  return crypto.randomUUID();
}
export function requireUser(ctx: WorkspaceContext): void {
  if (!ctx.userId) fail(403, "Workspace membership required");
}
export function text(value: unknown, max = 100): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f]/.test(value)
  )
    fail(400, "Invalid text");
  return value.trim();
}
export class NomadPending extends Error {
  readonly pending = true;
  constructor(message = "Waiting for machine response") {
    super(message);
  }
}

export async function boundedText(
  request: Request,
  max = 2 * 1024 * 1024,
): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      fail(413, "Request too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
