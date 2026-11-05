import assert from 'node:assert';
import fs from 'node:fs';
import test, { after, before } from 'node:test';

process.env.PGLITE_DIR = 'memory';
process.env.DATABASE_URL = ''; // Tests must never touch a real database, even if .env sets one.

const { connect, closeDb, query } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { setTokenVerifier } = await import('../server/auth.js');
const { seedDemo } = await import('../server/seed.js');
const { csvCell } = await import('../server/api.js');

const USERS = {
    'demo-token': { id: '11111111-1111-4111-8111-111111111111', email: 'manager@demo-fleet.example', user_metadata: {} },
    'other-token': {
        id: '22222222-2222-4222-8222-222222222222',
        email: 'sam@other.example',
        user_metadata: { fleet_company: 'Other Co', full_name: 'Sam' },
    },
    'driver-token': { id: '33333333-3333-4333-8333-333333333333', email: 'driver@example.com', user_metadata: {} },
};

let server, base, demo, other, driverAccount;

class Client {
    constructor(token) {
        this.token = token;
    }

    async call(path, { method = 'GET', body } = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.token) headers.Authorization = `Bearer ${this.token}`;
        const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const isJson = res.headers.get('content-type')?.includes('json');
        return { status: res.status, headers: res.headers, body: isJson ? await res.json() : await res.text() };
    }
}

before(async () => {
    setTokenVerifier(async (token) => USERS[token] ?? null);
    await connect();
    const owner = USERS['demo-token'];
    await seedDemo({ owner: { id: owner.id, name: 'Demo Manager', email: owner.email } });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/fleet`;
    demo = new Client('demo-token');
    other = new Client('other-token');
    driverAccount = new Client('driver-token');
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await closeDb();
});

test('seed data has the expected shape', async () => {
    const drivers = (await demo.call('/drivers')).body;
    assert.strictEqual(drivers.length, 14);
    assert.ok(drivers.every((d) => d.safety_score >= 0 && d.safety_score <= 100));
    assert.ok(drivers.some((d) => d.status === 'active') && drivers.some((d) => d.status === 'offline'));
});

test('overview numbers agree with the drivers list', async () => {
    const overview = (await demo.call('/overview')).body;
    const drivers = (await demo.call('/drivers')).body;
    assert.strictEqual(overview.total_drivers, drivers.length);
    assert.strictEqual(overview.active_drivers, drivers.filter((d) => d.status === 'active').length);
    const avg = Math.round(drivers.reduce((s, d) => s + d.safety_score, 0) / drivers.length);
    assert.strictEqual(overview.avg_score, avg);
    assert.strictEqual(overview.vehicles.length, overview.active_drivers);
});

test('all data routes need a login', async () => {
    const anonymous = new Client();
    for (const path of ['/auth/me', '/overview', '/drivers', '/alerts', '/reports', '/settings']) {
        assert.strictEqual((await anonymous.call(path)).status, 401, path);
    }
});

test('a forged token is refused', async () => {
    assert.strictEqual((await new Client('forged').call('/drivers')).status, 401);
});

test('a driver account is not a fleet manager', async () => {
    for (const path of ['/auth/me', '/overview', '/drivers', '/alerts', '/reports', '/settings']) {
        assert.strictEqual((await driverAccount.call(path)).status, 403, path);
    }
    const [row] = await query(`SELECT count(*)::int AS n FROM fleet_members WHERE user_id = $1`, [USERS['driver-token'].id]);
    assert.strictEqual(row.n, 0);
});

test('a fleet sign-up gets its company on first use, and only once', async () => {
    const me = (await other.call('/auth/me')).body;
    assert.strictEqual(me.companyName, 'Other Co');
    assert.strictEqual(me.name, 'Sam');
    await other.call('/auth/me');
    const [row] = await query(`SELECT count(*)::int AS n FROM companies WHERE name = 'Other Co'`);
    assert.strictEqual(row.n, 1);
});

test('supabase/fleet.sql has the same tables as the local schema', () => {
    const local = fs.readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
    const hosted = fs.readFileSync(new URL('../../supabase/fleet.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(hosted.includes(local));
});

test('one company can never see or change another company', async () => {
    const [driver] = (await demo.call('/drivers')).body;
    const [alert] = (await demo.call('/alerts')).body;

    assert.deepStrictEqual((await other.call('/drivers')).body, []);
    assert.deepStrictEqual((await other.call('/alerts')).body, []);
    assert.strictEqual((await other.call(`/drivers/${driver.id}`)).status, 404);
    assert.strictEqual((await other.call(`/drivers/${driver.id}`, { method: 'DELETE' })).status, 404);
    assert.strictEqual((await other.call(`/alerts/${alert.id}/acknowledge`, { method: 'POST' })).status, 404);

    const report = (await other.call(`/reports?driverId=${driver.id}`)).body;
    assert.strictEqual(report.driver, null);
    assert.deepStrictEqual(report.drivers, []);
    assert.strictEqual(report.summary.alerts, 0);
    assert.strictEqual((await demo.call(`/drivers/${driver.id}`)).status, 200);
});

test('a new company starts empty and does not break', async () => {
    const overview = (await other.call('/overview')).body;
    assert.strictEqual(overview.total_drivers, 0);
    assert.strictEqual(overview.avg_score, null);
    const report = (await other.call('/reports?period=month')).body;
    assert.strictEqual(report.trend.length, 30);
    assert.strictEqual(report.summary.avg_score, null);
});

test('adding and removing a driver works and validates input', async () => {
    assert.strictEqual((await other.call('/drivers', { method: 'POST', body: { name: 'No Plate' } })).status, 400);
    const created = await other.call('/drivers', { method: 'POST', body: { name: 'New Driver', vehiclePlate: 'rad 1 a' } });
    assert.strictEqual(created.status, 201);
    const [driver] = (await other.call('/drivers')).body;
    assert.strictEqual(driver.vehicle_plate, 'RAD 1 A');
    assert.strictEqual(driver.safety_score, null);
    assert.strictEqual((await other.call(`/drivers/${driver.id}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await other.call('/drivers/not-a-uuid')).status, 404);
});

test('report totals match the driver rows and the period', async () => {
    const week = (await demo.call('/reports?period=week')).body;
    const month = (await demo.call('/reports?period=month')).body;
    assert.strictEqual(week.trend.length, 7);
    assert.strictEqual(month.trend.length, 30);
    assert.strictEqual(week.summary.alerts, week.drivers.reduce((s, d) => s + d.alerts, 0));
    assert.ok(month.summary.alerts >= week.summary.alerts);
    const [driver] = week.drivers;
    const single = (await demo.call(`/reports?driverId=${driver.id}`)).body;
    assert.strictEqual(single.driver, driver.name);
    assert.strictEqual(single.summary.alerts, driver.alerts);
});

test('CSV export downloads, and formula cells are neutralised', async () => {
    const res = await demo.call('/reports/export.csv?period=week');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.strictEqual(res.body.split('\r\n').length, 15);
    assert.strictEqual(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.strictEqual(csvCell('a,b'), '"a,b"');
    assert.strictEqual(csvCell(42), '42');
});

test('acknowledging an alert removes it from the open list', async () => {
    const [alert] = (await demo.call('/alerts?open=true')).body;
    await demo.call(`/alerts/${alert.id}/acknowledge`, { method: 'POST' });
    const open = (await demo.call('/alerts?open=true')).body;
    assert.ok(!open.some((a) => a.id === alert.id));
});

test('notification settings require a destination when enabled', async () => {
    const bad = await other.call('/settings/notifications', { method: 'PATCH', body: { smsEnabled: true, smsTo: '' } });
    assert.strictEqual(bad.status, 400);
    const good = await other.call('/settings/notifications', {
        method: 'PATCH', body: { emailEnabled: false, smsEnabled: true, smsTo: '+250 788 000 000' },
    });
    assert.strictEqual(good.status, 200);
    const saved = (await other.call('/settings')).body.notifications;
    assert.strictEqual(saved.sms_enabled, true);
    assert.strictEqual(saved.email_enabled, false);
});
