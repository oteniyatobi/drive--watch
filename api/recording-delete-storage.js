// POST /api/recording-delete-storage
// Body: { path } — removes object from Supabase Storage for the authenticated user.

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
        const { error } = await supabase.storage.from(bucket).remove([path]);

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('recording-delete-storage:', e);
        return res.status(500).json({ error: e?.message || 'Delete failed' });
    }
};
