import { z } from 'zod';

// Reject alternate number formats before converting to a number.
const positiveInteger = z.string().regex(/^[1-9]\d*$/).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export const recommendationParamsSchema = z.object({ userId: positiveInteger });
export const recommendationQuerySchema = z.strictObject({
  limit: positiveInteger.pipe(z.number().max(20)).default(5),
});
