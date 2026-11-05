import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { createApi } from './api.js';
import { IS_PROD, ROOT } from './config.js';

export function createApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(helmet({
        // OpenStreetMap refuses tile requests that carry no referrer.
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            },
        },
    }));
    app.use(express.json({ limit: '50kb' }));
    app.use(cookieParser());
    app.use('/api', createApi());
    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

    const dist = path.join(ROOT, 'dist');
    if (fs.existsSync(dist)) {
        app.use(express.static(dist));
        app.get(/.*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
    }

    app.use((error, req, res, next) => {
        if (error.status && error.status < 500) return res.status(error.status).json({ error: 'Invalid request.' });
        console.error(error);
        res.status(500).json({ error: IS_PROD ? 'Something went wrong.' : error.message });
    });
    return app;
}
