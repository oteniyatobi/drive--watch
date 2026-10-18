// POST /api/recording-presign
// Verifies the Supabase access token, returns Cloudinary signed upload parameters.
// The client uses these to POST the video blob directly to Cloudinary (no server bandwidth used).
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getUserIdFromRequest, AuthError } = require('./_lib/supabaseAdmin');
const { getCloudinaryConfig, generateSignature } = require('./_lib/cloudinaryAdmin');

const ID_RE = /^[a-zA-Z0-9_-]{6,200}$/;

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const uid = await getUserIdFromRequest(req);

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
        if (e instanceof AuthError) {
            return res.status(401).json({ error: e.message });
        }
        const msg = e?.message || String(e);
        if (msg.includes('SUPABASE')) {
            return res.status(503).json({ error: 'Server missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.' });
        }
        if (msg.includes('CLOUDINARY')) {
            return res.status(503).json({ error: 'Server missing Cloudinary environment variables.' });
        }
        return res.status(500).json({ error: msg });
    }
};
