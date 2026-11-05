const test = require('node:test');
const assert = require('node:assert');

const sent = [];
const calls = [];
let profile;
class AuthError extends Error {}

function stub(path, exports) {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}

const fakeTwilio = () => ({
    messages: { create: async (m) => { sent.push(m); return { sid: 'SM1' }; } },
    calls: { create: async (c) => { calls.push(c); } },
});
fakeTwilio.twiml = { VoiceResponse: class { say() {} toString() { return '<Response/>'; } } };
stub('twilio', fakeTwilio);

stub('../api/_lib/supabaseAdmin', {
    AuthError,
    getUserIdFromRequest: async (req) => {
        if (req.headers.authorization !== 'Bearer good') throw new AuthError('Invalid or expired auth token.');
        return 'user-1';
    },
    getSupabaseAdmin: () => ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }),
    }),
});

process.env.TWILIO_ACCOUNT_SID = 'AC1';
process.env.TWILIO_AUTH_TOKEN = 'token';
process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+10000000000';
delete process.env.TWILIO_POLICE_NUMBER;

const handler = require('../api/send-alert');

async function call({ method = 'POST', headers = { authorization: 'Bearer good' }, body = {} } = {}) {
    const res = {
        statusCode: 200,
        headers: {},
        payload: undefined,
        setHeader(k, v) { this.headers[k] = v; },
        status(c) { this.statusCode = c; return this; },
        json(p) { this.payload = p; return this; },
        end() { return this; },
    };
    await handler({ method, headers, body }, res);
    return res;
}

test.beforeEach(() => {
    sent.length = 0;
    calls.length = 0;
    profile = { driver_name: 'Ada', emergency_contact_phone: '+250 700 000 001' };
});

test('rejects callers without a valid login and sends nothing', async () => {
    const res = await call({ headers: {}, body: { to: '+19998887777' } });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(sent.length, 0);
});

test('sends to the saved contact, never to a number in the request', async () => {
    const res = await call({ body: { to: '+19998887777', driverName: 'Fake', alertType: 'drowsy' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(sent[0].to, 'whatsapp:+250700000001');
    assert.match(sent[0].body, /Ada/);
    assert.doesNotMatch(sent[0].body, /Fake/);
});

test('impact voice call also goes to the saved contact', async () => {
    await call({ body: { to: '+19998887777', alertType: 'impact' } });
    assert.strictEqual(calls[0].to, '+250700000001');
});

test('fails clearly when no emergency contact is saved', async () => {
    profile = { driver_name: 'Ada', emergency_contact_phone: null };
    const res = await call();
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(sent.length, 0);
});

test('keeps real map links and drops anything else', async () => {
    await call({ body: { mapsLink: 'https://maps.google.com/?q=-1.95,30.06' } });
    assert.match(sent[0].body, /q=-1\.95,30\.06/);
    await call({ body: { mapsLink: 'https://evil.example/phish' } });
    assert.doesNotMatch(sent[1].body, /evil/);
});

test('answers the mobile app preflight', async () => {
    const res = await call({ method: 'OPTIONS', headers: { origin: 'https://localhost' } });
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], 'https://localhost');
});

test('does not allow other websites', async () => {
    const res = await call({ method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], undefined);
});
