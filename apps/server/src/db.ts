// Postgres connections. A single server hosts two databases:
//   gps      — the platform: `gps` schema (business) and `auth` schema (session)
//   traccar  — the gateway's database; the platform only reads and purges it
import pg from "pg";
import type { Config } from "./config";

// bigint arrives as text by default; this database's identifiers fit in a number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export interface Db {
  /** `gps` database, `gps` schema. */
  core: pg.Pool;
  /** `gps` database, with search_path on `auth`: used by the session library. */
  auth: pg.Pool;
  /** `traccar` database. */
  traccar: pg.Pool;
  close(): Promise<void>;
}

export function createDb(config: Config): Db {
  const common = { idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "gps-app" };
  const core = new pg.Pool({ connectionString: config.databaseUrl, max: 10, ...common });
  const auth = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    options: "-c search_path=auth",
    ...common,
  });
  const traccar = new pg.Pool({ connectionString: config.traccar.databaseUrl, max: 3, ...common });
  for (const pool of [core, auth, traccar]) {
    // A failure on an idle connection must not bring down the process.
    pool.on("error", (err) => console.error("[db] error on an idle connection:", err.message));
  }
  return {
    core,
    auth,
    traccar,
    async close() {
      await Promise.allSettled([core.end(), auth.end(), traccar.end()]);
    },
  };
}

/** Runs `fn` inside a transaction on the `gps` database. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type Queryable = Pick<pg.Pool, "query">;
