// Strukturované logování (pino). V produkci JSON na stdout (sbírá Docker), ve vývoji čitelně přes pino-pretty.
import pino from 'pino';
import type { FastifyBaseLogger } from 'fastify';

export function vytvorLogger(level: string, env: string): FastifyBaseLogger {
  const l =
    env === 'development'
      ? pino({
          level,
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        })
      : pino({ level });
  return l as unknown as FastifyBaseLogger;
}

// minimální rozhraní, které používají služby (vyhovuje mu pino i FastifyBaseLogger)
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
