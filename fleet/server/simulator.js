import { query } from './db.js';
import { PLACES, buildRoute } from './places.js';

const TICK_MS = 3000;
const STEP = 0.04; // Share of a route covered per tick

const round = (n) => Number(n.toFixed(5));

function newLeg(lat, lng) {
    const start = { lat, lng };
    const options = PLACES.filter((p) => Math.hypot(p.lat - lat, p.lng - lng) > 0.01);
    const end = options[Math.floor(Math.random() * options.length)];
    return { route: buildRoute(start, end, Math.random, 40), progress: 0 };
}

function positionOn({ route, progress }) {
    const at = progress * (route.length - 1);
    const i = Math.min(Math.floor(at), route.length - 2);
    const f = at - i;
    const [aLat, aLng] = route[i];
    const [bLat, bLng] = route[i + 1];
    return {
        lat: round(aLat + (bLat - aLat) * f),
        lng: round(aLng + (bLng - aLng) * f),
        heading: Math.round(((Math.atan2(bLng - aLng, bLat - aLat) * 180) / Math.PI + 360) % 360),
    };
}

/** Moves the demo fleet and raises occasional alerts. Stand-in until real devices report in. */
export function startSimulator(companyId) {
    const legs = new Map();
    let nextAlertAt = Date.now() + 8000;
    let running = false;

    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const drivers = await query(
                `SELECT id, name, vehicle_plate, lat, lng FROM drivers WHERE company_id = $1 AND status = 'active'`,
                [companyId],
            );
            for (const driver of drivers) {
                let leg = legs.get(driver.id);
                if (!leg || leg.progress >= 1) {
                    leg = newLeg(driver.lat, driver.lng);
                    legs.set(driver.id, leg);
                }
                leg.progress = Math.min(1, leg.progress + STEP * (0.7 + Math.random() * 0.6));
                const position = positionOn(leg);
                const speed = Math.round(28 + Math.random() * 37);
                await query(
                    `UPDATE drivers SET lat = $2, lng = $3, heading = $4, speed_kmh = $5, last_seen = now() WHERE id = $1`,
                    [driver.id, position.lat, position.lng, position.heading, speed],
                );
            }

            if (drivers.length && Date.now() >= nextAlertAt) {
                nextAlertAt = Date.now() + 15000 + Math.random() * 30000;
                const driver = drivers[Math.floor(Math.random() * drivers.length)];
                const roll = Math.random();
                const severity = roll < 0.18 ? 'critical' : roll < 0.6 ? 'medium' : 'low';
                const type = ['drowsiness', 'distraction', 'phone_use'][Math.floor(Math.random() * 3)];
                await query(
                    `INSERT INTO alerts (company_id, driver_id, type, severity, lat, lng)
                     SELECT company_id, id, $2, $3, lat, lng FROM drivers WHERE id = $1`,
                    [driver.id, type, severity],
                );
            }
        } catch (error) {
            console.error('simulator:', error.message);
        } finally {
            running = false;
        }
    };

    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
}
