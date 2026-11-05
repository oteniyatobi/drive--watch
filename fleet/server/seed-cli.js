import { createClient } from '@supabase/supabase-js';
import './config.js';
import { closeDb, connect } from './db.js';
import { removeDemo, seedDemo } from './seed.js';

const email = process.argv[2]?.toLowerCase();
if (!email) {
    console.error('Usage: npm run seed -- manager@example.com');
    process.exit(1);
}

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (error) throw error;
const user = data.users.find((u) => u.email?.toLowerCase() === email);
if (!user) {
    console.error(`No Supabase account uses ${email}. Sign up first.`);
    process.exit(1);
}

// Replaces only the demo company. Other companies are left alone.
await connect();
await removeDemo();
console.log(await seedDemo({ owner: { id: user.id, name: user.user_metadata?.full_name || email, email } }));
await closeDb();
