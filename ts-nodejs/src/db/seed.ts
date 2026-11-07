import { readConfig } from '../config.js';
import { initializeSchema, openDatabase } from './connection.js';
import { loadDataset, seedDatabase } from './seed-data.js';

try {
  const config = readConfig();
  const data = loadDataset();
  const db = openDatabase(config.databasePath);
  try {
    initializeSchema(db);
    const counts = seedDatabase(db, data);
    console.log(`Seeded ${config.databasePath}`);
    console.log(counts);
  } finally {
    db.close();
  }
} catch (error) {
  console.error('Database seed failed:', error);
  process.exitCode = 1;
}
