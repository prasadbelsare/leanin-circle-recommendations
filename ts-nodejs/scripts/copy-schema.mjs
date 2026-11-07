import { copyFileSync } from 'node:fs';

copyFileSync(new URL('../src/db/schema.sql', import.meta.url), new URL('../dist/db/schema.sql', import.meta.url));
