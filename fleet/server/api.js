import express from 'express';
import { requireAuth } from './auth.js';
import { one, query } from './db.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = ['drowsiness', 'distraction', 'phone_use'];
const SEVERITIES = ['low', 'medium', 'critical'];

const text = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const badRequest = (res, error) => res.status(400).json({ error });

const DRIVER_LIST_SQL = `
    SELECT d.id, d.name, d.email, d.phone, d.license_no, d.vehicle_plate, d.vehicle_model, d.status,
           d.safety_score, d.lat, d.lng, d.heading, d.speed_kmh, d.last_seen, d.created_at,
           (SELECT max(t.ended_at) FROM trips t WHERE t.driver_id = d.id) AS last_trip,
           (SELECT count(*)::int FROM alerts a WHERE a.driver_id = d.id AND a.occurred_at > now() - interval '30 days') AS alerts_count
    FROM drivers d WHERE d.company_id = $1`;

const ALERT_SELECT = `
    SELECT a.id, a.driver_id, a.type, a.severity, a.occurred_at, a.lat, a.lng, a.acknowledged_at,
           d.name AS driver_name, d.vehicle_plate
    FROM alerts a JOIN drivers d ON d.id = a.driver_id`;

/** Quotes a CSV value, and stops spreadsheets running a cell that looks like a formula. */
export function csvCell(value) {
    let cell = String(value);
    if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

async function buildReport(req) {
    const days = req.query.period === 'month' ? 30 : 7;
    const driverId = UUID.test(req.query.driverId ?? '') ? req.query.driverId : null;
    const params = [req.companyId, days, driverId];
    const driverFilter = 'AND ($3::uuid IS NULL OR driver_id = $3::uuid)';

    const [company, current, previous, trend, drivers, driver] = await Promise.all([
        one(`SELECT name, timezone FROM companies WHERE id = $1`, [req.companyId]),
        one(`SELECT count(*)::int AS alerts, count(*) FILTER (WHERE severity = 'critical')::int AS critical
             FROM alerts WHERE company_id = $1 AND occurred_at > now() - make_interval(days => $2::int) ${driverFilter}`, params),
        one(`SELECT count(*)::int AS alerts
             FROM alerts WHERE company_id = $1 AND occurred_at <= now() - make_interval(days => $2::int)
               AND occurred_at > now() - make_interval(days => $2::int * 2) ${driverFilter}`, params),
        query(`WITH c AS (SELECT timezone FROM companies WHERE id = $1),
               days AS (SELECT generate_series((now() AT TIME ZONE c.timezone)::date - ($2::int - 1), (now() AT TIME ZONE c.timezone)::date, interval '1 day')::date AS day FROM c)
               SELECT days.day::text AS day,
                      count(a.id) FILTER (WHERE a.type = 'drowsiness')::int AS drowsiness,
                      count(a.id) FILTER (WHERE a.type = 'distraction')::int AS distraction,
                      count(a.id) FILTER (WHERE a.type = 'phone_use')::int AS phone_use,
                      (SELECT round(avg(s.score))::int FROM driver_scores s JOIN drivers d ON d.id = s.driver_id
                       WHERE d.company_id = $1 AND s.day = days.day AND ($3::uuid IS NULL OR s.driver_id = $3::uuid)) AS avg_score
               FROM days CROSS JOIN c
               LEFT JOIN alerts a ON a.company_id = $1 AND ($3::uuid IS NULL OR a.driver_id = $3::uuid)
                    AND (a.occurred_at AT TIME ZONE c.timezone)::date = days.day
               GROUP BY days.day ORDER BY days.day`, params),
        query(`SELECT d.id, d.name, d.vehicle_plate, d.safety_score,
                      coalesce(t.trips, 0)::int AS trips, coalesce(t.km, 0)::float8 AS km,
                      coalesce(a.alerts, 0)::int AS alerts, coalesce(a.critical, 0)::int AS critical
               FROM drivers d
               LEFT JOIN (SELECT driver_id, count(*) AS trips, round(sum(distance_km)::numeric, 1) AS km
                          FROM trips WHERE started_at > now() - make_interval(days => $2::int) GROUP BY driver_id) t ON t.driver_id = d.id
               LEFT JOIN (SELECT driver_id, count(*) AS alerts, count(*) FILTER (WHERE severity = 'critical') AS critical
                          FROM alerts WHERE occurred_at > now() - make_interval(days => $2::int) GROUP BY driver_id) a ON a.driver_id = d.id
               WHERE d.company_id = $1 AND ($3::uuid IS NULL OR d.id = $3::uuid)
               ORDER BY alerts DESC, d.name`, params),
        driverId ? one(`SELECT name FROM drivers WHERE id = $1 AND company_id = $2`, [driverId, req.companyId]) : null,
    ]);

    const scored = trend.filter((d) => d.avg_score !== null);
    return {
        company: company.name,
        period: days === 30 ? 'month' : 'week',
        days,
        driver: driver?.name ?? null,
        summary: {
            alerts: current.alerts,
            previous_alerts: previous.alerts,
            critical: current.critical,
            trips: drivers.reduce((sum, d) => sum + d.trips, 0),
            km: Math.round(drivers.reduce((sum, d) => sum + d.km, 0)),
            avg_score: scored.length ? Math.round(scored.reduce((sum, d) => sum + d.avg_score, 0) / scored.length) : null,
        },
        trend,
        drivers,
    };
}

export function createApi() {
    const api = express.Router();

    // Everything here belongs to one company, taken from the signed-in user and never from the request.
    api.use(requireAuth);

    api.get('/auth/me', (req, res) => {
        const { id, name, email, company_name: companyName } = req.user;
        res.json({ id, name, email, companyName });
    });

    api.get('/overview', async (req, res) => {
        const id = req.companyId;
        const [stats, alerts, vehicles, recent] = await Promise.all([
            one(`SELECT count(*)::int AS total_drivers,
                        count(*) FILTER (WHERE status = 'active')::int AS active_drivers,
                        round(avg(safety_score))::int AS avg_score
                 FROM drivers WHERE company_id = $1`, [id]),
            one(`SELECT count(*) FILTER (WHERE day = today)::int AS today,
                        count(*) FILTER (WHERE day = today AND severity = 'critical')::int AS critical_today,
                        count(*) FILTER (WHERE day = today - 1)::int AS yesterday
                 FROM (SELECT a.severity, (a.occurred_at AT TIME ZONE c.timezone)::date AS day,
                              (now() AT TIME ZONE c.timezone)::date AS today
                       FROM alerts a JOIN companies c ON c.id = a.company_id
                       WHERE a.company_id = $1 AND a.occurred_at > now() - interval '3 days') recent`, [id]),
            query(`SELECT id, name, vehicle_plate, lat, lng, heading, speed_kmh, safety_score
                   FROM drivers WHERE company_id = $1 AND status = 'active' AND lat IS NOT NULL ORDER BY name`, [id]),
            query(`${ALERT_SELECT} WHERE a.company_id = $1 ORDER BY a.occurred_at DESC LIMIT 6`, [id]),
        ]);
        res.json({
            ...stats,
            alerts_today: alerts.today,
            critical_today: alerts.critical_today,
            alerts_yesterday: alerts.yesterday,
            vehicles,
            recent,
        });
    });

    api.get('/drivers', async (req, res) => {
        res.json(await query(`${DRIVER_LIST_SQL} ORDER BY d.name`, [req.companyId]));
    });

    api.post('/drivers', async (req, res) => {
        const name = text(req.body?.name);
        const plate = text(req.body?.vehiclePlate, 20).toUpperCase();
        if (!name || !plate) return badRequest(res, 'Driver name and vehicle plate are required.');
        const email = text(req.body?.email);
        if (email && !EMAIL.test(email)) return badRequest(res, 'Enter a valid email, or leave it blank.');
        const driver = await one(
            `INSERT INTO drivers (company_id, name, email, phone, license_no, vehicle_plate, vehicle_model)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [req.companyId, name, email, text(req.body?.phone, 40), text(req.body?.licenseNo, 40), plate, text(req.body?.vehicleModel, 80)],
        );
        res.status(201).json(driver);
    });

    api.delete('/drivers/:id', async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Driver not found.' });
        const removed = await one(`DELETE FROM drivers WHERE id = $1 AND company_id = $2 RETURNING id`, [req.params.id, req.companyId]);
        if (!removed) return res.status(404).json({ error: 'Driver not found.' });
        res.json({ ok: true });
    });

    api.get('/drivers/:id', async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Driver not found.' });
        const driver = await one(`${DRIVER_LIST_SQL} AND d.id = $2`, [req.companyId, req.params.id]);
        if (!driver) return res.status(404).json({ error: 'Driver not found.' });
        const [scores, trips, alerts] = await Promise.all([
            query(`SELECT day::text AS day, score FROM driver_scores WHERE driver_id = $1 ORDER BY day`, [driver.id]),
            query(`SELECT id, started_at, ended_at, distance_km, start_label, end_label, route,
                          (SELECT count(*)::int FROM alerts a WHERE a.driver_id = t.driver_id AND a.occurred_at BETWEEN t.started_at AND t.ended_at) AS alerts
                   FROM trips t WHERE driver_id = $1 ORDER BY started_at DESC LIMIT 25`, [driver.id]),
            query(`${ALERT_SELECT} WHERE a.driver_id = $1 ORDER BY a.occurred_at DESC LIMIT 100`, [driver.id]),
        ]);
        res.json({ driver, scores, trips, alerts });
    });

    api.get('/alerts', async (req, res) => {
        const params = [req.companyId];
        let where = 'a.company_id = $1';
        if (TYPES.includes(req.query.type)) {
            params.push(req.query.type);
            where += ` AND a.type = $${params.length}`;
        }
        if (SEVERITIES.includes(req.query.severity)) {
            params.push(req.query.severity);
            where += ` AND a.severity = $${params.length}`;
        }
        if (req.query.open === 'true') where += ' AND a.acknowledged_at IS NULL';
        res.json(await query(`${ALERT_SELECT} WHERE ${where} ORDER BY a.occurred_at DESC LIMIT 200`, params));
    });

    api.post('/alerts/:id/acknowledge', async (req, res) => {
        if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Alert not found.' });
        const alert = await one(
            `UPDATE alerts SET acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = $1 AND company_id = $2 RETURNING id`,
            [req.params.id, req.companyId],
        );
        if (!alert) return res.status(404).json({ error: 'Alert not found.' });
        res.json({ ok: true });
    });

    api.get('/reports', async (req, res) => {
        res.json(await buildReport(req));
    });

    api.get('/reports/export.csv', async (req, res) => {
        const report = await buildReport(req);
        const lines = [
            ['Driver', 'Vehicle', 'Safety score', 'Trips', 'Distance (km)', 'Alerts', 'Critical alerts'],
            ...report.drivers.map((d) => [d.name, d.vehicle_plate, d.safety_score ?? '', d.trips, d.km, d.alerts, d.critical]),
        ];
        res.set({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="driverwatch-${report.period}ly-report.csv"`,
        });
        res.send(lines.map((row) => row.map(csvCell).join(',')).join('\r\n'));
    });

    api.get('/settings', async (req, res) => {
        const [company, notifications] = await Promise.all([
            one(`SELECT name, address, phone, timezone FROM companies WHERE id = $1`, [req.companyId]),
            one(`SELECT email_enabled, sms_enabled, email_to, sms_to FROM notification_prefs WHERE company_id = $1`, [req.companyId]),
        ]);
        res.json({ company, notifications });
    });

    api.patch('/settings/company', async (req, res) => {
        const name = text(req.body?.name);
        if (!name) return badRequest(res, 'Company name is required.');
        await query(`UPDATE companies SET name = $2, address = $3, phone = $4 WHERE id = $1`,
            [req.companyId, name, text(req.body?.address), text(req.body?.phone, 40)]);
        res.json({ ok: true });
    });

    api.patch('/settings/notifications', async (req, res) => {
        const emailEnabled = req.body?.emailEnabled === true;
        const smsEnabled = req.body?.smsEnabled === true;
        const emailTo = text(req.body?.emailTo);
        const smsTo = text(req.body?.smsTo, 40);
        if (emailEnabled && !EMAIL.test(emailTo)) return badRequest(res, 'Enter an email address for critical alerts.');
        if (smsEnabled && !/^\+?[0-9 ()-]{7,}$/.test(smsTo)) return badRequest(res, 'Enter a phone number for SMS alerts.');
        await query(
            `INSERT INTO notification_prefs (company_id, email_enabled, sms_enabled, email_to, sms_to) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (company_id) DO UPDATE SET email_enabled = $2, sms_enabled = $3, email_to = $4, sms_to = $5`,
            [req.companyId, emailEnabled, smsEnabled, emailTo, smsTo],
        );
        res.json({ ok: true });
    });

    return api;
}
