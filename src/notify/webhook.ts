/**
 * webhookNotifier — POSTs notification events as JSON to a URL.
 * SPEC §6.3.
 *
 * Failures are reported via the optional `onError` callback; they do NOT
 * throw, because notifier failures must never block the press/clear flow
 * the notification accompanies.
 */

import type { Notifier, NotificationEvent } from './types.js';

export interface WebhookNotifierOptions {
  url: string;
  headers?: Record<string, string>;
  /** Override fetch (for testing). */
  fetch?: typeof fetch;
  /** Callback on non-2xx, network error, or timeout. */
  onError?: (err: unknown, event: NotificationEvent) => void;
  /** Request timeout in ms. Defaults to 5000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function webhookNotifier(options: WebhookNotifierOptions): Notifier {
  const fetchImpl = options.fetch ?? fetch;
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      try {
        const resp = await fetchImpl(options.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.headers ?? {}),
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });
        if (!resp.ok) {
          options.onError?.(new Error(`webhook_status_${resp.status}`), event);
        }
      } catch (err) {
        options.onError?.(err, event);
      }
      clearTimeout(timer);
    },
  };
}
