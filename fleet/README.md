# driverwatch fleet

The fleet manager dashboard, served at app.driverwatch.tech/fleet from the same Vercel project as the driver app.
React, Tailwind and an Express API that runs as one Vercel function (`api/fleet.mjs`).

## How sign-in works

Drivers and managers use the same page, `login.html`, and the same Supabase accounts.

- A row in `fleet_members` is what makes an account a manager. After sign-in, managers go to `/fleet/` and everyone else stays in the driver app.
- Only the server can write to `fleet_members`, so the role can't be claimed from the browser.
- A company signs up at `/fleet/register`. The company name is kept on the account, and the API creates the company on the first signed-in request, after the email is confirmed.
- The API checks the Supabase token on every request and takes the company from the signed-in user, never from the request.

## Hosting setup

1. Run `supabase/fleet.sql` in the Supabase SQL Editor.
2. In Vercel, set `DATABASE_URL` to the Supabase **Transaction pooler** connection string (port 6543).
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already there for the driver app.

The root `npm run build` builds this app into `www/fleet`.

## Run it locally

```bash
cd fleet
npm install
cp .env.example .env   # add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run dev
```

Open http://localhost:5173/fleet/. Without `DATABASE_URL` the data goes in a local database in `.data/`, while sign-in still uses Supabase.

| Command | What it does |
|---|---|
| `npm run dev` | Runs the API on port 4000 and the site on port 5173, or the next free port |
| `npm test` | Runs the API tests. They always use a throwaway database |
| `npm run build` | Checks types and builds the site into `../www/fleet` |
| `npm run seed -- you@example.com` | Replaces the demo company and makes that account its manager. It moves the account out of any other company |

## What is mock data

- All drivers, trips, scores and alerts in the demo company.
- Routes are curves between real Kigali areas and do not follow roads.
- The driver app doesn't report to this dashboard yet, so a real company's drivers are the ones typed in on the Drivers page, with no trips or alerts.
- `server/simulator.js` moves demo vehicles during local development only.
- Safety scores are stored numbers. Nothing calculates them from driving yet.

Email and SMS preferences are saved but nothing is sent yet.

## Limits

- The dashboard checks for changes every 10 seconds, because Vercel functions can't hold a live stream open.
- Set `VITE_MAP_TILES` to a paid map provider before real traffic. OpenStreetMap's public tiles are not meant for production.
- The Android app doesn't include the dashboard. A manager who signs in there is told to use the website.
