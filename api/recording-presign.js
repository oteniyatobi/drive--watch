// POST /api/recording-presign
// Verifies Firebase ID token, returns Supabase signed upload URL (client PUTs the video blob).
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET (default: recordings), FIREBASE_SERVICE_ACCOUNT_JSON

const { getFirebaseAdmin } = require('./lib/firebaseAdmin');
const { getSupabaseAdmin } = require('./lib/supabaseAdmin');

const ID_RE = /^[a-zA-Z0-9_-]{6,200}$/;

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing Authorization Bearer token' });
        }
        const idToken = authHeader.slice(7);

        const admin = getFirebaseAdmin();
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
        const id = body.id;
        if (!id || typeof id !== 'string' || !ID_RE.test(id)) {
            return res.status(400).json({ error: 'Invalid or missing id' });
        }

        const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'recordings';
        const path = `users/${uid}/videos/${id}.webm`;

        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);

        if (error) {
            console.error('Supabase createSignedUploadUrl:', error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({
            signedUrl: data.signedUrl,
            path: data.path || path,
            token: data.token || null,
            bucket
        });
    } catch (e) {
        console.error('recording-presign:', e);
        const msg = e?.message || String(e);
        if (msg.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
            return res.status(503).json({ error: 'Server missing FIREBASE_SERVICE_ACCOUNT_JSON (Firebase Admin).' });
        }
        if (msg.includes('SUPABASE') || msg.includes('not set')) {
            return res.status(503).json({ error: 'Server missing Supabase env vars (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).' });
        }
        if (msg.includes('auth') || msg.includes('token') || msg.includes('Firebase')) {
            return res.status(401).json({ error: 'Invalid or expired token' });
        }
        return res.status(500).json({ error: msg });
    }
};
