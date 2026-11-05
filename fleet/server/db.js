import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataDir } from './config.js';

let client;

/** Uses DATABASE_URL (Supabase or any Postgres) when set, otherwise embedded Postgres on disk. */
export async function connect() {
    if (client) return client;
    if (process.env.DATABASE_URL) {
        const { default: pg } = await import('pg');
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
        client = {
            query: (sql, params) => pool.query(sql, params),
            exec: (sql) => pool.query(sql),
            close: () => pool.end(),
        };
    } else {
        const { PGlite } = await import('@electric-sql/pglite');
        const dir = process.env.PGLITE_DIR === 'memory' ? undefined : path.join(dataDir(), 'pg');
        const lite = await PGlite.create(dir);
        client = {
            query: (sql, params) => lite.query(sql, params),
            exec: (sql) => lite.exec(sql),
            close: () => lite.close(),
        };
    }
    await client.exec(fs.readFileSync(path.join(ROOT, 'server/schema.sql'), 'utf8'));
    return client;
}

export async function query(sql, params = []) {
    return (await client.query(sql, params)).rows;
}

export async function one(sql, params = []) {
    return (await query(sql, params))[0] ?? null;
}

export async function closeDb() {
    await client?.close();
    client = undefined;
}
