// Migrations: versioned SQL files in db/migrations/<folder>/NNNN_name.sql.
// Each file is applied exactly once, in order and inside a transaction.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pg from "pg";

const LOCK_KEY = 0x67707301; // prevents two processes from migrating at once

export function findMigrationsDir(configured: string): string {
  const candidates = [
    configured,
    resolve(process.cwd(), "db/migrations"),
    resolve(process.cwd(), "../../db/migrations"),
  ].filter(Boolean);
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`Migrations folder not found (tried: ${candidates.join(", ")})`);
  return found;
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function readMigrations(root: string): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  const folders = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  // The core goes first; then each module, in alphabetical order.
  folders.sort((a, b) => (a === "core" ? -1 : b === "core" ? 1 : a.localeCompare(b)));
  for (const folder of folders) {
    const names = (await readdir(join(root, folder))).filter((f) => f.endsWith(".sql") && !f.startsWith(".")).sort();
    for (const file of names) {
      const sql = await readFile(join(root, folder, file), "utf8");
      files.push({ name: `${folder}/${file}`, sql, checksum: sha256(sql) });
    }
  }
  return files;
}

export async function migrate(pool: pg.Pool, root: string): Promise<string[]> {
  const migrations = await readMigrations(root);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query("CREATE SCHEMA IF NOT EXISTS gps");
    await client.query(`
      CREATE TABLE IF NOT EXISTS gps.schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM gps.schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    for (const m of migrations) {
      const previous = done.get(m.name);
      if (previous !== undefined) {
        if (previous !== m.checksum) throw new Error(`Migration ${m.name} changed after it was applied. Changes go in a new file.`);
        continue;
      }
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO gps.schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(m.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
