import type { Store, Doc, Selection } from "./core";

export class SqlStore implements Store {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,id))",
    );
    // The original (collection,id) key cannot satisfy insertion-order reads.
    // This index also contains rowid, keeping collection scans out of unrelated history.
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS documents_collection ON documents(collection)",
    );
    for (const [name, fields, onlyCollection] of [
      ["command_key", ["key"], "commands"],
      ["command_queue", ["machine_id", "completed_at", "expires_at"], "commands"],
      ["sample_time", ["sampled_at"], "samples"],
      ["created_time", ["created_at"], null],
    ] as const) {
      storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS documents_${name} ON documents(collection,${fields.map((f) => `json_extract(value,'$.${f}')`).join(",")})${onlyCollection ? ` WHERE collection='${onlyCollection}'` : ""}`,
      );
    }
  }
  get<T = Doc>(collection: string, id: string): T | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM documents WHERE collection=? AND id=?",
        collection,
        id,
      )
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  list<T = Doc>(collection: string): T[] {
    return this.select<T>(collection);
  }
  private filter(collection: string, selection: Selection) {
    const values: (string | number | null)[] = [collection];
    const clauses = ["collection=?"];
    const field = (name: string) => {
      if (!/^[a-z_]+$/.test(name)) throw new Error("Invalid document field");
      return `json_extract(value,'$.${name}')`;
    };
    for (const [name, value] of Object.entries(selection.equal ?? {})) {
      clauses.push(`${field(name)} IS ?`);
      values.push(value);
    }
    for (const [range, op] of [
      [selection.before, "<"],
      [selection.after, ">="],
    ] as const) {
      if (range) {
        clauses.push(`${field(range.field)} ${op} ?`);
        values.push(range.value);
      }
    }
    const eq = selection.equal ?? {},
      range = selection.before ?? selection.after;
    const index =
      collection === "commands" && "key" in eq
        ? "command_key"
        : collection === "commands" && "machine_id" in eq && "completed_at" in eq
          ? "command_queue"
          : collection === "samples" && range?.field === "sampled_at"
            ? "sample_time"
            : range?.field === "created_at"
              ? "created_time"
              : "collection";
    if(index === "command_key" || index === "command_queue") clauses.push("collection='commands'");
    if(index === "sample_time") clauses.push("collection='samples'");
    return {
      where: clauses.join(" AND "),
      values,
      index: `documents_${index}`,
    };
  }
  select<T = Doc>(collection: string, selection: Selection = {}): T[] {
    const { where, values, index } = this.filter(collection, selection);
    const limit = selection.limit === undefined ? "" : " LIMIT ?";
    if (selection.limit !== undefined) {
      if (!Number.isInteger(selection.limit) || selection.limit < 1)
        throw new Error("Invalid document limit");
      values.push(selection.limit);
    }
    return this.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM documents INDEXED BY ${index} WHERE ${where} ORDER BY rowid ${selection.reverse ? "DESC" : "ASC"}${limit}`,
        ...values,
      )
      .toArray()
      .map((r) => JSON.parse(r.value) as T);
  }
  prune(collection: string, field: string, before: string): void {
    const { where, values, index } = this.filter(collection, {
      before: { field, value: before },
    });
    this.storage.sql.exec(
      `DELETE FROM documents INDEXED BY ${index} WHERE ${where}`,
      ...values,
    );
  }
  put(collection: string, id: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT INTO documents(collection,id,value) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value",
      collection,
      id,
      JSON.stringify(value),
    );
  }
  delete(collection: string, id: string) {
    this.storage.sql.exec(
      "DELETE FROM documents WHERE collection=? AND id=?",
      collection,
      id,
    );
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
