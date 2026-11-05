import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const IS_PROD = process.env.NODE_ENV === 'production';
export const PORT = Number(process.env.PORT) || 4000;

// The demo company moves around by itself in development only.
export const DEMO_ENABLED = !IS_PROD && process.env.SEED_DEMO !== 'false';
export const DEMO_COMPANY_ID = '00000000-0000-4000-8000-000000000001';

export function dataDir() {
    const dir = path.join(ROOT, '.data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
