import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

// Lazily initialised — DATABASE_URL is validated on first use, not at
// module load time. This lets the server start without a database
// configured; routes that actually query the DB will throw at request
// time with a clear diagnostic message.
let _pool: pg.Pool | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function connect() {
  if (_db) return { pool: _pool!, db: _db };
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }
  _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  _db = drizzle(_pool, { schema });
  return { pool: _pool, db: _db };
}

/** Returns the Drizzle database instance. Throws if DATABASE_URL is not set. */
export function getDb() {
  return connect().db;
}

/** Returns the underlying pg.Pool. Throws if DATABASE_URL is not set. */
export function getPool() {
  return connect().pool;
}

export * from "./schema";
