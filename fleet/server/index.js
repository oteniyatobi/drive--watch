import { DEMO_ENABLED, DEMO_LOGIN, PORT } from './config.js';
import { connect } from './db.js';
import { createApp } from './app.js';
import { demoCompanyId, seedDemo } from './seed.js';
import { startSimulator } from './simulator.js';

await connect();

if (DEMO_ENABLED) {
    let companyId = await demoCompanyId();
    if (!companyId) {
        const seeded = await seedDemo();
        companyId = seeded.company;
        console.log(`Seeded demo fleet: ${seeded.drivers} drivers, ${seeded.trips} trips, ${seeded.alerts} alerts`);
    }
    if (process.env.SIMULATE !== 'false') startSimulator(companyId);
    console.log(`Demo login: ${DEMO_LOGIN.email}`);
}

createApp().listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
