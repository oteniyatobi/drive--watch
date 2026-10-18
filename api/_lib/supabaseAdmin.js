const { createClient } = require('@supabase/supabase-js');

let client;

function getSupabaseAdmin() {
    if (!client) {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
            throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
        }
        client = createClient(url, key, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return client;
}

class AuthError extends Error {}

/** Verifies the Supabase access token in "Authorization: Bearer <token>" and returns the user id. */
async function getUserIdFromRequest(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new AuthError('Missing Authorization Bearer token');
    }
    const { data, error } = await getSupabaseAdmin().auth.getUser(authHeader.slice(7));
    if (error || !data || !data.user) {
        throw new AuthError('Invalid or expired auth token.');
    }
    return data.user.id;
}

module.exports = { getSupabaseAdmin, getUserIdFromRequest, AuthError };
