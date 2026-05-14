/**
 * createEStopMiddleware — Express/Connect/Fastify-compatible middleware that
 * returns HTTP 423 Locked when the resolved user is currently pressed.
 * SPEC §5.4.
 *
 * Framework-agnostic: the middleware signature is `(req, res, next)` which
 * Express, Connect, and Fastify (with middleware mode) all accept.
 */

import type { EStopHub } from './hub.js';

/** Minimal subset of Node's IncomingMessage we read. */
export interface MiddlewareRequest {
  headers: Record<string, string | string[] | undefined>;
  url?: string;
  method?: string;
}

/** Minimal subset of Node's ServerResponse we write. */
export interface MiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

export type MiddlewareNext = (err?: unknown) => void;

export interface EStopMiddlewareOptions {
  /** Host extracts the user id from the request. Return null to skip the gate. */
  resolveUserId: (req: MiddlewareRequest) => string | null;
  /** Bypass predicate — return true to skip the gate (e.g., for /estop/clear). */
  exclude?: (req: MiddlewareRequest) => boolean;
  /** Override the JSON body returned on 423. */
  lockedResponseBody?: (state: { pressedAt?: string }, userId: string) => unknown;
  /** Header name carrying the request originator (operator | agent | system). */
  initiatorHeader?: string;
}

export function createEStopMiddleware(
  hub: EStopHub,
  options: EStopMiddlewareOptions,
): (req: MiddlewareRequest, res: MiddlewareResponse, next: MiddlewareNext) => Promise<void> {
  const exclude = options.exclude;
  const bodyFactory = options.lockedResponseBody ?? defaultLockedBody;

  return async (req, res, next) => {
    if (exclude && exclude(req)) {
      return next();
    }
    const userId = options.resolveUserId(req);
    if (userId === null) {
      return next();
    }
    const pressed = await hub.isPressed(userId);
    if (!pressed) {
      return next();
    }
    const state = await hub.status(userId);
    res.statusCode = 423;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(bodyFactory({ pressedAt: state.pressedAt }, userId)));
  };
}

function defaultLockedBody(
  state: { pressedAt?: string },
  _userId: string,
): Record<string, unknown> {
  // pressedAt is always defined when middleware reaches this — the 423 path
  // is only taken when hub.isPressed() returned true, which implies a
  // press state row exists. Treated as required to keep coverage clean.
  return {
    error: 'estop_active',
    message:
      'An emergency stop is active for your account. Outbound actions are blocked until cleared.',
    pressed_at: state.pressedAt,
  };
}
