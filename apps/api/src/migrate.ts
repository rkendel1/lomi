import { loadConfig } from './config';
import { migrate } from './db/pool';

/** `node dist/migrate.js` — applies pending migrations, then exits. Safe to run concurrently (advisory lock). */
const config = loadConfig();
migrate(config.databaseUrl)
  .then((applied) => {
    console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
