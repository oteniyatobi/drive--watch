import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const IS_PROD = process.env.NODE_ENV === 'production';
export const PORT = Number(process.env.PORT) || 4000;

// The demo account has a published password, so it never exists in production unless asked for.
export const DEMO_ENABLED = IS_PROD ? process.env.SEED_DEMO === 'true' : process.env.SEED_DEMO !== 'false';
export const DEMO_LOGIN = { email: 'manager@demo-fleet.example', password: 'DriverWatch-demo-2026' };

export function dataDir() {
    const dir = path.join(ROOT, '.data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function loadSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
    if (IS_PROD) throw new Error('JWT_SECRET must be set in production.');
    // Kept on disk so a dev server restart does not sign everyone out.
    const file = path.join(dataDir(), 'dev-secret');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
    return fs.readFileSync(file, 'utf8');
}

export const JWT_SECRET = loadSecret();
