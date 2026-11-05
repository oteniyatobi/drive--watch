import { createApp } from '../fleet/server/app.js';
import { connect } from '../fleet/server/db.js';

let app;

/** Runs the fleet Express API. vercel.json sends /api/fleet/* here with the rest of the path in ?path=. */
export default async function handler(req, res) {
    if (!process.env.DATABASE_URL) {
        return res.status(503).json({ error: 'The fleet database is not configured.' });
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.searchParams.getAll('path').join('/');
    url.searchParams.delete('path');
    if (path) req.url = `/api/fleet/${path}${url.search}`;

    if (!app) {
        await connect();
        app = createApp();
    }
    return app(req, res);
}
