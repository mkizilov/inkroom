import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const DEVELOPMENT_WEB_ORIGIN = 'http://127.0.0.1:21173';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(21080),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'DATABASE_URL must be a postgres:// URL'),
  WEB_ORIGIN: z
    .string()
    .url()
    .transform((value) => new URL(value).origin)
    .optional(),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Comma-separated addresses or CIDR ranges of reverse proxies whose X-Forwarded-For is trusted.
  TRUST_PROXY: z.string().optional(),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  webOrigin: string;
  cookieSecure: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
  trustProxy: string[];
}

// Validates the environment and returns the settings the server needs. Production has stricter
// rules: the web origin must be set explicitly and use HTTPS, and cookies must stay Secure.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const production = parsed.NODE_ENV === 'production';

  if (production && parsed.WEB_ORIGIN === undefined) {
    throw new Error('WEB_ORIGIN must be set in production.');
  }
  if (production && !parsed.WEB_ORIGIN?.startsWith('https://')) {
    throw new Error('WEB_ORIGIN must use https:// in production.');
  }
  if (production && parsed.COOKIE_SECURE === 'false') {
    throw new Error('COOKIE_SECURE cannot be false in production.');
  }

  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    webOrigin: parsed.WEB_ORIGIN ?? DEVELOPMENT_WEB_ORIGIN,
    // Secure cookies are the default in production; set COOKIE_SECURE to override outside it.
    cookieSecure: parsed.COOKIE_SECURE === undefined ? production : parsed.COOKIE_SECURE === 'true',
    logLevel: parsed.LOG_LEVEL,
    trustProxy: (parsed.TRUST_PROXY ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  };
}
