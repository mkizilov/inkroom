import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(21080),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z
    .string()
    .url()
    .transform((value) => new URL(value).origin)
    .default('http://127.0.0.1:21173'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
});

export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  webOrigin: string;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    databaseUrl: parsed.DATABASE_URL,
    webOrigin: parsed.WEB_ORIGIN,
    // Secure cookies are the default in production; set COOKIE_SECURE to override.
    cookieSecure:
      parsed.COOKIE_SECURE === undefined
        ? parsed.NODE_ENV === 'production'
        : parsed.COOKIE_SECURE === 'true',
  };
}
