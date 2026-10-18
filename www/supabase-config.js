// supabase-config.js
// Supabase Dashboard → Project Settings → API. Both values are safe to ship to the browser:
// row level security (supabase/schema.sql) is what protects the data.
const SUPABASE_URL = 'https://wtrzlatrpxzehdynymij.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0cnpsYXRycHh6ZWhkeW55bWlqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNzUxNzEsImV4cCI6MjEwNzg1MTE3MX0.q1G9HwRtHcmOkeZ_8E512TV5yelWC5wx_oQpN5-2sVo';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/** Current access token for calling /api/* routes (replaces Firebase user.getIdToken()). */
async function getAccessToken() {
    const { data } = await sb.auth.getSession();
    return data.session ? data.session.access_token : null;
}

/** profiles row → the shape the app has always used (was the Firestore users/{uid} doc). */
function profileFromRow(row) {
    if (!row) return null;
    return {
        driverName: row.driver_name || '',
        sex: row.sex || '',
        email: row.email || '',
        phone: row.phone || '',
        emergencyContact: {
            name: row.emergency_contact_name || '',
            phone: row.emergency_contact_phone || ''
        },
        locationConsentGranted: !!row.location_consent_granted
    };
}

/** Partial app-shaped profile → profiles columns. */
function profileToRow(p) {
    const row = {};
    if ('driverName' in p) row.driver_name = p.driverName;
    if ('sex' in p) row.sex = p.sex;
    if ('email' in p) row.email = p.email;
    if ('phone' in p) row.phone = p.phone;
    if (p.emergencyContact) {
        row.emergency_contact_name = p.emergencyContact.name;
        row.emergency_contact_phone = p.emergencyContact.phone;
    }
    if ('locationConsentGranted' in p) row.location_consent_granted = p.locationConsentGranted;
    return row;
}

async function fetchProfile(userId) {
    const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw error;
    return profileFromRow(data);
}
