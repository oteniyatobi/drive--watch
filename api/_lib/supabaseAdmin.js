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

module.exports = { getSupabaseAdmin };
