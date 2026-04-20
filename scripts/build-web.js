/**
 * build-web.js — copies web assets into the www/ folder that Capacitor reads.
 * Run with: npm run build:web
 * Your original source files are never modified.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEST = path.join(ROOT, 'www');

// Web assets to include in the mobile app
const ASSETS = [
    'index.html',
    'login.html',
    'app.js',
    'login.js',
    'firebase-config.js',
    'map.js',
    'style.css',
    'service-worker.js',
    'manifest.json',
    'favicon.png',
    'icon-192.png',
    'icon-512.png',
    'model',        // AI model directory (model.json + weights.bin + metadata.json)
];

function copyRecursive(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        fs.mkdirSync(dest, { recursive: true });
        for (const child of fs.readdirSync(src)) {
            copyRecursive(path.join(src, child), path.join(dest, child));
        }
    } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

// Clean and recreate www/
if (fs.existsSync(DEST)) {
    fs.rmSync(DEST, { recursive: true, force: true });
}
fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const asset of ASSETS) {
    const src = path.join(ROOT, asset);
    const dest = path.join(DEST, asset);
    if (!fs.existsSync(src)) {
        console.warn(`  SKIP  ${asset} (not found)`);
        continue;
    }
    copyRecursive(src, dest);
    console.log(`  COPY  ${asset}`);
    copied++;
}

console.log(`\nBuild complete — ${copied} assets copied to www/`);
