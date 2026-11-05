# driverwatch fleet

The fleet manager dashboard for fleet.driverwatch.tech. React, Tailwind, Express and Postgres.

## Run it

```bash
cd fleet
npm install
npm run dev
```

Open the `Local` address it prints (normally http://localhost:5173) and press **Fill in demo account** on the sign-in page.

No accounts or keys are needed. The first start creates a local database in `.data/` and fills it with a
demo company: 14 drivers, 60 days of trips and alerts, and vehicles that move around Kigali.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the API on port 4000 and the site on port 5173, or the next free port |
| `npm test` | Runs the API tests |
| `npm run build` | Checks types and builds the site into `dist/` |
| `npm start` | Runs the API and the built site together on port 4000 |
| `npm run seed` | Replaces the demo company with fresh data. Stop the server first |

## What is mock data

- All drivers, trips, scores and alerts in the demo company.
- Routes are curves between real Kigali areas and do not follow roads.
- `server/simulator.js` moves vehicles and raises alerts. Replace it with device data when that exists.
- Safety scores are stored numbers. Nothing calculates them from driving yet.

Email and SMS preferences are saved but nothing is sent yet.

## Before going live

- Set `JWT_SECRET` and `NODE_ENV=production`. The server refuses to start in production without the secret.
- Set `DATABASE_URL`. The built-in database is for one local server only.
- Host the API on something that stays running, such as Render, Railway or Fly. Live updates hold a connection
  open, and the in-process event bus and rate limiter assume a single server, so Vercel functions will not work.
- Set `VITE_MAP_TILES` to a paid map provider. OpenStreetMap's public tiles are not meant for production traffic.
- The demo account is off in production. Keep it that way, because its password is in this repository.
