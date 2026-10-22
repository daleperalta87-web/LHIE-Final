'use strict';
// Usage: node scripts/migrate.js [--reset]   (applies migrations + seed; --reset wipes data first)
const db = require('../src/db');

(async () => {
  try {
    if (process.argv.includes('--reset')) {
      await db.exec('truncate referrals, fhir_resource_history, fhir_resources, audit_log restart identity cascade');
      console.log('Cleared referrals, FHIR resources and audit log.');
    }
    await db.init();
    console.log(db.EMBEDDED ? 'Embedded Postgres ready in ' + db.DATA_DIR : 'Migrations and seed applied');
    await db.close();
  } catch (e) {
    console.error(e.message);
    await db.close();
    process.exitCode = 1;
  }
})();
