// POST /api/recording-play-url
// Body: { path } — must be users/<uid>/videos/... for the authenticated Firebase user.

const { getFirebaseAdmin } = require('./lib/firebaseAdmin');
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing Authorization Bearer token' });
        }

        const admin = getFirebaseAdmin();
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        const uid = decoded.uid;

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
        const path = body.path;
        if (!path || typeof path !== 'string') {
            return res.status(400).json({ error: 'Missing path' });
        }
        if (!path.startsWith(`users/${uid}/`)) {
            return res.status(403).json({ error: 'Forbidden path' });
        }

        const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'recordings';
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ signedUrl: data.signedUrl });
    } catch (e) {
        console.error('recording-play-url:', e);
        const msg = e?.message || String(e);
        if (msg.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
            return res.status(503).json({ error: 'Server missing FIREBASE_SERVICE_ACCOUNT_JSON.' });
        }
        if (msg.includes('SUPABASE') || msg.includes('not set')) {
            return res.status(503).json({ error: 'Server missing Supabase env vars.' });
        }
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};
