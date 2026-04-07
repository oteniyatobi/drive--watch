// POST /api/recording-delete-storage
// Body: { publicId } — destroys a Cloudinary video for the authenticated user.
// Security: publicId must be under the user's own folder in Cloudinary.
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, FIREBASE_SERVICE_ACCOUNT_JSON

const { getFirebaseAdmin }  = require('./lib/firebaseAdmin');
const { getCloudinaryConfig, generateSignature } = require('./lib/cloudinaryAdmin');

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

        const body     = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const publicId = body.publicId;
        if (!publicId || typeof publicId !== 'string') {
            return res.status(400).json({ error: 'Missing publicId' });
        }

        // Security: only allow deleting from the user's own folder
        if (!publicId.startsWith(`driverwatch/users/${uid}/`)) {
            return res.status(403).json({ error: 'Forbidden: cannot delete another user\'s recording.' });
        }

        const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();

        const timestamp    = Math.round(Date.now() / 1000);
        const paramsToSign = { public_id: publicId, timestamp };
        const signature    = generateSignature(paramsToSign, apiSecret);

        const formData = new URLSearchParams({
            public_id:     publicId,
            timestamp:     String(timestamp),
            api_key:       apiKey,
            signature,
        });

        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudName}/video/destroy`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    formData.toString(),
            }
        );

        const result = await response.json();

        // "not found" is still treated as success (idempotent delete)
        if (result.result === 'ok' || result.result === 'not found') {
            return res.status(200).json({ success: true });
        }

        return res.status(500).json({ error: `Cloudinary delete error: ${result.result}` });

    } catch (e) {
        console.error('recording-delete-storage:', e);
        return res.status(500).json({ error: e?.message || 'Delete failed' });
    }
};
