// The Android/iOS app loads its pages from the device, so its calls to /api are cross-origin.
// Auth uses a Bearer token, not cookies, so only these app origins need to be allowed.
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

/** Sets CORS headers. Returns true when this was a preflight and the handler should stop. */
function handleCors(req, res) {
    const origin = req.headers.origin;
    if (APP_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return true;
    }
    return false;
}

module.exports = { handleCors };
