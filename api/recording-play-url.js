// POST /api/recording-play-url
// Returns the Cloudinary permanent URL stored in Firestore for this user's recording.
// Cloudinary URLs are publicly accessible by default — no signed URL generation needed.
// Env: FIREBASE_SERVICE_ACCOUNT_JSON

const { getFirebaseAdmin } = require('./_lib/firebaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing Authorization Bearer token' });
        }

        const admin   = getFirebaseAdmin();
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        const uid     = decoded.uid;

        const body        = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const recordingId = body.id;
        if (!recordingId || typeof recordingId !== 'string') {
            return res.status(400).json({ error: 'Missing recording id' });
        }

        const db  = admin.firestore();
        const doc = await db.collection('users').doc(uid).collection('recordings').doc(recordingId).get();

        if (!doc.exists) {
            return res.status(404).json({ error: 'Recording not found' });
        }

        const data = doc.data();
        if (!data.url) {
            return res.status(404).json({ error: 'Playback URL not available for this recording' });
        }

        return res.status(200).json({ signedUrl: data.url });
    } catch (e) {
        console.error('recording-play-url:', e);
        const msg = e?.message || String(e);
        if (msg.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
            return res.status(503).json({ error: 'Server missing FIREBASE_SERVICE_ACCOUNT_JSON.' });
        }
        return res.status(500).json({ error: msg });
    }
};
