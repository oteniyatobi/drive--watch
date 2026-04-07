// POST /api/recording-presign
// Verifies Firebase ID token, returns Cloudinary signed upload parameters.
// The client uses these to POST the video blob directly to Cloudinary (no server bandwidth used).
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON

const { getFirebaseAdmin }    = require('./lib/firebaseAdmin');
const { getCloudinaryConfig, generateSignature } = require('./lib/cloudinaryAdmin');

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

        const admin   = getFirebaseAdmin();
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid     = decoded.uid;

        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const id   = body.id;
        if (!id || typeof id !== 'string' || !ID_RE.test(id)) {
            return res.status(400).json({ error: 'Invalid or missing recording id' });
        }

        const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();

        const timestamp = Math.round(Date.now() / 1000);
        const folder    = `driverwatch/users/${uid}`;
        const publicId  = `${folder}/${id}`;

        // Sign the params the client will send to Cloudinary
        const paramsToSign = { folder, public_id: publicId, timestamp };
        const signature    = generateSignature(paramsToSign, apiSecret);

        return res.status(200).json({
            cloudName,
            apiKey,
            timestamp,
            signature,
            folder,
            publicId,
            uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`,
        });
    } catch (e) {
        console.error('recording-presign:', e);
        const msg = e?.message || String(e);
        if (msg.includes('FIREBASE_SERVICE_ACCOUNT_JSON')) {
            return res.status(503).json({ error: 'Server missing FIREBASE_SERVICE_ACCOUNT_JSON (Firebase Admin).' });
        }
        if (msg.includes('CLOUDINARY')) {
            return res.status(503).json({ error: 'Server missing Cloudinary environment variables.' });
        }
        if (msg.includes('auth') || msg.includes('token') || msg.includes('Firebase')) {
            return res.status(401).json({ error: 'Invalid or expired auth token.' });
        }
        return res.status(500).json({ error: msg });
    }
};
