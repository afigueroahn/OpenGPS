// Prints the SQL the session library needs and that is not in the database yet.
// Its output is saved as a new migration in db/migrations/core, with
// `SET LOCAL search_path TO auth;` at the top.
//
//   pnpm --filter @opengps/server auth:schema
//
// With the database up to date it prints nothing: it serves to detect changes
// when the library is upgraded.
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { createDb } from "../src/db";

const config = loadConfig();
const db = createDb(config);
try {
  await db.core.query("CREATE SCHEMA IF NOT EXISTS auth");
  const { auth } = createAuth(config, db, { send: async () => {}, verify: async () => {} });
  const plan = await getMigrations(auth.options, { throwOnUnsafe: false });
  for (const problem of [...plan.unsafeChanges, ...plan.schemaProblems]) console.error(`AVISO: ${problem}`);
  const sql = await plan.compileMigrations();
  process.stdout.write(sql.trim() ? `${sql.trim()}\n` : "");
  console.error(
    `tablas nuevas: ${plan.toBeCreated.map((t) => t.table).join(", ") || "ninguna"} · columnas nuevas en: ${
      plan.toBeAdded.map((t) => t.table).join(", ") || "ninguna"
    }`,
  );
} finally {
  await db.close();
}
