/**
 * The database — Drizzle over `bun:sqlite`, opened lazily.
 *
 * **Lazily is load-bearing.** The compiler imports every window module at build
 * time to evaluate components, so module scope must not touch the filesystem —
 * a top-level `new Database(…)` would create `todos.sqlite` during compilation.
 * The handle is created on first use, which only ever happens at run time,
 * inside a handler or a loader.
 *
 * The schema is applied on open with `CREATE TABLE IF NOT EXISTS` — one table,
 * no migration step to run before the app starts. When the schema grows past
 * that, `drizzle-kit` picks up from the same `todos` definition below.
 */
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  done: integer("done", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

export type Todo = typeof todos.$inferSelect;

let handle: BunSQLiteDatabase | null = null;

function db(): BunSQLiteDatabase {
  if (handle === null) {
    const sqlite = new Database("todos.sqlite");
    sqlite.run(
      `CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )`,
    );
    handle = drizzle(sqlite);
  }
  return handle;
}

// --- queries and mutations, all synchronous: bun:sqlite is in-process ---------

export function listTodos(): Todo[] {
  return db().select().from(todos).orderBy(todos.createdAt).all();
}

export function getTodo(id: string): Todo | undefined {
  return db().select().from(todos).where(eq(todos.id, id)).get();
}

export function insertTodo(title: string): void {
  db().insert(todos).values({ id: crypto.randomUUID(), title, done: false, createdAt: Date.now() }).run();
}

export function setDone(id: string, done: boolean): void {
  db().update(todos).set({ done }).where(eq(todos.id, id)).run();
}

export function setTitle(id: string, title: string): void {
  db().update(todos).set({ title }).where(eq(todos.id, id)).run();
}

export function removeTodo(id: string): void {
  db().delete(todos).where(eq(todos.id, id)).run();
}
