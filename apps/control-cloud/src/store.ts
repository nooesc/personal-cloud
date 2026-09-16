import type { Store, Doc } from "./core";
export class SqlStore implements Store {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS documents (collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(collection,id))",
    );
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
    return this.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM documents WHERE collection=? ORDER BY rowid",
        collection,
      )
      .toArray()
      .map((row) => JSON.parse(row.value) as T);
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
