import { createApp } from './app.js';
import { readConfig } from './config.js';
import { initializeSchema, openDatabase } from './db/connection.js';

const config = readConfig();
const db = openDatabase(config.databasePath);
initializeSchema(db);
const server = createApp(db).listen(config.port, () => {
  console.log(`Circle API listening on http://localhost:${config.port}`);
});

function shutdown() {
  server.close(() => {
    db.close();
  });
}

server.on('error', error => {
  console.error('Server failed:', error);
  db.close();
  process.exitCode = 1;
});
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
