// POST /api/recording-play-url
// Returns the Cloudinary permanent URL stored in Supabase for this user's recording.
// Cloudinary URLs are publicly accessible by default — no signed URL generation needed.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getSupabaseAdmin, getUserIdFromRequest, AuthError } = require('./_lib/supabaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const uid = await getUserIdFromRequest(req);

        const body        = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const recordingId = body.id;
        if (!recordingId || typeof recordingId !== 'string') {
            return res.status(400).json({ error: 'Missing recording id' });
        }

        const { data, error } = await getSupabaseAdmin()
            .from('recordings')
            .select('url')
            .eq('user_id', uid)
            .eq('id', recordingId)
            .maybeSingle();
        if (error) throw error;

        if (!data) {
            return res.status(404).json({ error: 'Recording not found' });
        }
        if (!data.url) {
            return res.status(404).json({ error: 'Playback URL not available for this recording' });
        }

        return res.status(200).json({ signedUrl: data.url });
    } catch (e) {
        console.error('recording-play-url:', e);
        if (e instanceof AuthError) {
            return res.status(401).json({ error: e.message });
        }
        const msg = e?.message || String(e);
        if (msg.includes('SUPABASE')) {
            return res.status(503).json({ error: 'Server missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.' });
        }
        return res.status(500).json({ error: msg });
    }
};
