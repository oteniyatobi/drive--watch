import { createClient } from '@supabase/supabase-js';
import { one, query } from './db.js';

let admin;

async function verifySupabaseToken(token) {
    admin ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
}

let verifyToken = verifySupabaseToken;

/** Lets the tests stand in for Supabase. */
export function setTokenVerifier(verifier) {
    verifyToken = verifier;
}

const findMember = (userId) => one(
    `SELECT m.user_id, m.name, m.email, m.company_id, c.name AS company_name
     FROM fleet_members m JOIN companies c ON c.id = m.company_id WHERE m.user_id = $1`,
    [userId],
);

/** Finishes a fleet sign-up. The company name waits in the account's metadata until the email is confirmed. */
async function createCompany(user) {
    const meta = user.user_metadata;
    const company = await one(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [String(meta.fleet_company).trim().slice(0, 200)]);
    await query(
        `INSERT INTO fleet_members (user_id, company_id, name, email) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING`,
        [user.id, company.id, String(meta.full_name ?? '').trim().slice(0, 200) || user.email, user.email ?? ''],
    );
    await query(`INSERT INTO notification_prefs (company_id, email_to) VALUES ($1,$2)`, [company.id, user.email ?? '']);
    return findMember(user.id);
}

/** Looks the manager up on every request, so a removed account loses access immediately. */
export async function requireAuth(req, res, next) {
    const header = req.headers.authorization ?? '';
    const user = header.startsWith('Bearer ') ? await verifyToken(header.slice(7)) : null;
    if (!user) return res.status(401).json({ error: 'Please sign in.' });

    let member = await findMember(user.id);
    if (!member && user.user_metadata?.fleet_company) member = await createCompany(user);
    if (!member) return res.status(403).json({ error: 'This account is not a fleet manager.' });

    req.user = { id: member.user_id, name: member.name, email: member.email, company_name: member.company_name };
    req.companyId = member.company_id;
    next();
}
