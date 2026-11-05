import assert from 'node:assert';
import test, { after, before } from 'node:test';

process.env.PGLITE_DIR = 'memory';
process.env.JWT_SECRET = 'test-secret';

const { connect, closeDb, query } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedDemo } = await import('../server/seed.js');
const { csvCell } = await import('../server/api.js');
const { DEMO_LOGIN } = await import('../server/config.js');
const { publish } = await import('../server/bus.js');

let server, base, demo, other;

class Client {
    cookie = '';
    async call(path, { method = 'GET', body } = {}) {
        const res = await fetch(base + path, {
            method,
            headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
            body: body ? JSON.stringify(body) : undefined,
        });
        const set = res.headers.get('set-cookie');
        if (set) this.cookie = set.split(';')[0];
        const isJson = res.headers.get('content-type')?.includes('json');
        return { status: res.status, headers: res.headers, body: isJson ? await res.json() : await res.text() };
    }
}

before(async () => {
    await connect();
    await seedDemo();
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}/api`;
    demo = new Client();
    other = new Client();
    assert.strictEqual((await demo.call('/auth/login', { method: 'POST', body: DEMO_LOGIN })).status, 200);
    const registered = await other.call('/auth/register', {
        method: 'POST',
        body: { companyName: 'Other Co', name: 'Sam', email: 'sam@other.example', password: 'long-enough-password' },
    });
    assert.strictEqual(registered.status, 201);
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
    for (const path of ['/overview', '/drivers', '/alerts', '/reports', '/settings', '/stream']) {
        assert.strictEqual((await anonymous.call(path)).status, 401, path);
    }
});

test('a wrong password and a forged session are both refused', async () => {
    const client = new Client();
    const res = await client.call('/auth/login', { method: 'POST', body: { email: DEMO_LOGIN.email, password: 'wrong' } });
    assert.strictEqual(res.status, 401);
    client.cookie = 'dw_session=eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.';
    assert.strictEqual((await client.call('/drivers')).status, 401);
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

test('live events reach only the company they belong to', async () => {
    const open = async (client) => {
        const controller = new AbortController();
        const res = await fetch(`${base}/stream`, { headers: { Cookie: client.cookie }, signal: controller.signal });
        return { reader: res.body.getReader(), controller };
    };
    const [demoCompany] = await query(`SELECT company_id FROM users WHERE email = $1`, [DEMO_LOGIN.email]);
    const mine = await open(demo);
    const theirs = await open(other);
    await mine.reader.read();
    await theirs.reader.read();

    publish(demoCompany.company_id, { type: 'alert', data: { secret: 'demo-only' } });
    const received = new TextDecoder().decode((await mine.reader.read()).value);
    assert.match(received, /demo-only/);

    const leaked = await Promise.race([theirs.reader.read(), new Promise((r) => setTimeout(() => r(null), 200))]);
    assert.strictEqual(leaked, null);
    mine.controller.abort();
    theirs.controller.abort();
});
