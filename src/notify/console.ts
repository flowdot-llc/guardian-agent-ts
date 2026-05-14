/**
 * consoleNotifier — writes notification events to stderr (or a configured stream).
 * SPEC §6.3.
 */

import type { Notifier, NotificationEvent } from './types.js';

export interface ConsoleNotifierOptions {
  /** Where to write. Defaults to process.stderr. */
  stream?: NodeJS.WritableStream;
  /** Prefix prepended to every line. Defaults to "[guardian]". */
  prefix?: string;
}

export function consoleNotifier(options: ConsoleNotifierOptions = {}): Notifier {
  const stream = options.stream ?? process.stderr;
  const prefix = options.prefix ?? '[guardian]';
  return {
    notify: async (event: NotificationEvent): Promise<void> => {
      stream.write(`${prefix} ${formatEvent(event)}\n`);
    },
  };
}

function formatEvent(event: NotificationEvent): string {
  const parts = [event.kind, `agent=${event.agentId || '-'}`, `source=${event.source}`];
  if (event.userId !== undefined) parts.push(`user=${event.userId}`);
  parts.push(`at=${event.ts}`);
  const summary = JSON.stringify(event.summary);
  if (summary !== '{}') parts.push(`summary=${summary}`);
  if (event.canonicalClearUrl !== undefined) {
    parts.push(`clear=${event.canonicalClearUrl}`);
  }
  return parts.join(' ');
}
