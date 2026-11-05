import { DEMO_ENABLED, PORT } from './config.js';
import { connect } from './db.js';
import { createApp } from './app.js';
import { demoCompanyId } from './seed.js';
import { startSimulator } from './simulator.js';

await connect();

if (DEMO_ENABLED && process.env.SIMULATE !== 'false') {
    const companyId = await demoCompanyId();
    if (companyId) startSimulator(companyId);
}

createApp().listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
