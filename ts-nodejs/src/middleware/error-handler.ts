import type { ErrorRequestHandler } from 'express';
import { UserNotFoundError } from '../recommendations/eligibility.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (error instanceof UserNotFoundError) {
    response.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
  } else if (error instanceof URIError) {
    response.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request parameters.' } });
  } else {
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unable to load recommendations.' } });
  }
};
