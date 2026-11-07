import { resolve } from 'node:path';
import { z } from 'zod';

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().trim().min(1).default('.local/circles.sqlite'),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const values = environmentSchema.parse(environment);
  return {
    port: values.PORT,
    databasePath: values.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(values.DATABASE_PATH),
  };
}
