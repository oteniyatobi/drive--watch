import { DEMO_COMPANY_ID } from './config.js';
import { one, query } from './db.js';
import { PLACES, buildRoute, routeLengthKm } from './places.js';

const DRIVERS = [
    ['Jean-Paul Habimana', 'RAD 412 C', 'Toyota Hiace', 94], ['Aline Uwase', 'RAE 118 B', 'Isuzu NPR', 91],
    ['Eric Niyonzima', 'RAC 903 F', 'Toyota Hilux', 72], ['Grace Mukamana', 'RAD 276 A', 'Mitsubishi Canter', 88],
    ['Patrick Nshimiyimana', 'RAF 551 D', 'Toyota Coaster', 64], ['Diane Ingabire', 'RAE 730 H', 'Toyota Hiace', 96],
    ['Emmanuel Bizimana', 'RAC 245 K', 'Isuzu NPR', 79], ['Claudine Uwimana', 'RAD 689 E', 'Nissan Navara', 85],
    ['Olivier Mugisha', 'RAF 102 G', 'Mitsubishi Canter', 58], ['Sandrine Umutoni', 'RAE 364 J', 'Toyota Hilux', 90],
    ['Innocent Hakizimana', 'RAC 817 L', 'Toyota Coaster', 76], ['Yvonne Kayitesi', 'RAD 530 M', 'Toyota Hiace', 93],
    ['Fabrice Ndayisaba', 'RAF 946 N', 'Isuzu NPR', 68], ['Josiane Iradukunda', 'RAE 271 P', 'Nissan Navara', 87],
];
const ACTIVE_DRIVERS = 9;
const DAY = 86400000;

function makeRandom(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function insertRows(table, columns, rows, casts = {}) {
    for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const params = [];
        const values = chunk.map((row) => `(${row.map((value, c) => {
            params.push(value);
            return `$${params.length}${casts[columns[c]] ?? ''}`;
        }).join(',')})`);
        await query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${values.join(',')}`, params);
    }
}

function pickType(r) {
    if (r < 0.42) return 'distraction';
    if (r < 0.74) return 'phone_use';
    return 'drowsiness';
}

function pickSeverity(r, riskiness) {
    if (r < 0.12 + riskiness * 0.25) return 'critical';
    return r < 0.55 ? 'medium' : 'low';
}

/** Fills the demo company and makes `owner` (a Supabase user) its manager. */
export async function seedDemo({ owner, now = Date.now() }) {
    const rand = makeRandom(20260105);
    const pick = (list) => list[Math.floor(rand() * list.length)];

    const company = await one(
        `INSERT INTO companies (id, name, address, phone) VALUES ($1, 'Demo Logistics Ltd', 'KG 7 Ave, Kigali', '+250 788 555 000') RETURNING id`,
        [DEMO_COMPANY_ID],
    );
    await query(
        `INSERT INTO fleet_members (user_id, company_id, name, email) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET company_id = $2`,
        [owner.id, company.id, owner.name, owner.email],
    );
    await query(
        `INSERT INTO notification_prefs (company_id, email_enabled, sms_enabled, email_to, sms_to)
         VALUES ($1, true, false, $2, '')`,
        [company.id, owner.email],
    );

    const scores = [];
    const trips = [];
    const alerts = [];

    for (const [index, [name, plate, model, target]] of DRIVERS.entries()) {
        const active = index % 3 !== 2 || index < 3;
        const slug = name.toLowerCase().split(' ')[0].replace(/[^a-z]/g, '');
        const home = pick(PLACES);
        const driver = await one(
            `INSERT INTO drivers (company_id, name, email, phone, license_no, vehicle_plate, vehicle_model, status, safety_score, lat, lng, heading, speed_kmh, last_seen)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13) RETURNING id`,
            [company.id, name, `${slug}@demo-fleet.example`, `+250 788 555 ${String(101 + index)}`,
                `RW-${100200 + index * 37}`, plate, model, active ? 'active' : 'offline', target,
                home.lat, home.lng, active ? 30 : 0, new Date(now - (active ? 0 : (2 + index) * 3600000))],
        );

        // Walk backwards from today's score, so the latest point matches the driver's current score.
        let score = target;
        for (let d = 0; d < 90; d++) {
            scores.push([driver.id, new Date(now - d * DAY).toISOString().slice(0, 10), Math.round(score)]);
            score = Math.min(100, Math.max(35, score + (rand() - 0.5) * 5 + (target - score) * 0.04 - 0.05));
        }

        const riskiness = (100 - target) / 45;
        for (let d = 0; d < 60; d++) {
            const dayStart = now - d * DAY;
            if (d > 0 && rand() < 0.14) continue;
            const tripCount = d === 0 ? (active ? 2 : 1) : 1 + Math.floor(rand() * 3);
            for (let t = 0; t < tripCount; t++) {
                const from = pick(PLACES);
                const to = pick(PLACES.filter((p) => p !== from));
                const route = buildRoute(from, to, rand);
                const km = routeLengthKm(route);
                const minutes = Math.round(km * (2.2 + rand() * 1.4));
                const end = dayStart - (t * 3 + 1 + rand() * 2) * 3600000;
                const start = end - minutes * 60000;
                trips.push([company.id, driver.id, new Date(start), new Date(end), Number(km.toFixed(1)), from.name, to.name, JSON.stringify(route)]);

                const count = Math.floor(rand() * (0.6 + riskiness * 3.2));
                for (let a = 0; a < count; a++) {
                    const point = pick(route);
                    alerts.push([company.id, driver.id, pickType(rand()), pickSeverity(rand(), riskiness),
                        new Date(start + rand() * (end - start)), point[0], point[1],
                        d > 2 ? new Date(end + 3600000) : null]);
                }
            }
        }
    }

    await insertRows('driver_scores', ['driver_id', 'day', 'score'], scores, { day: '::date' });
    await insertRows('trips', ['company_id', 'driver_id', 'started_at', 'ended_at', 'distance_km', 'start_label', 'end_label', 'route'], trips, { route: '::jsonb' });
    await insertRows('alerts', ['company_id', 'driver_id', 'type', 'severity', 'occurred_at', 'lat', 'lng', 'acknowledged_at'], alerts);
    // An offline driver was last seen at the end of their last trip.
    await query(
        `UPDATE drivers d SET last_seen = t.last_end
         FROM (SELECT driver_id, max(ended_at) AS last_end FROM trips GROUP BY driver_id) t
         WHERE t.driver_id = d.id AND d.company_id = $1 AND d.status = 'offline'`,
        [company.id],
    );
    return { company: company.id, drivers: DRIVERS.length, trips: trips.length, alerts: alerts.length };
}

export async function removeDemo() {
    await query(`DELETE FROM companies WHERE id = $1`, [DEMO_COMPANY_ID]);
}

export async function demoCompanyId() {
    return (await one(`SELECT id FROM companies WHERE id = $1`, [DEMO_COMPANY_ID]))?.id ?? null;
}
