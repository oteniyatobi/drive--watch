import { closeDb, connect } from './db.js';
import { removeDemo, seedDemo } from './seed.js';

// Replaces only the demo company. Other companies are left alone.
await connect();
await removeDemo();
console.log(await seedDemo());
await closeDb();
