import { query } from '../db/client.js';
const r = await query<{ filename: string }>('SELECT filename FROM _migrations ORDER BY filename');
console.log('Applied migrations:');
r.forEach(x => console.log(' ', x.filename));
process.exit(0);
