/**
 * multiNotifier — fan a notification out to several notifiers in parallel.
 * SPEC §6.3.
 *
 * Failures in one notifier do NOT stop the others. Errors are collected and
 * reported via the optional `onError` callback.
 */

import type { Notifier, NotificationEvent } from './types.js';

export interface MultiNotifierOptions {
  notifiers: readonly Notifier[];
  onError?: (err: unknown, event: NotificationEvent, index: number) => void;
}

export function multiNotifier(options: MultiNotifierOptions): Notifier {
  const { notifiers, onError } = options;
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      const results = await Promise.allSettled(
        notifiers.map(async (n) => n.notify(event)),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r?.status === 'rejected') {
          onError?.(r.reason, event, i);
        }
      }
    },
  };
}
