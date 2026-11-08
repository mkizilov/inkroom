import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const databaseUrl = 'postgres://inkroom:inkroom@127.0.0.1:21432/inkroom';
const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: databaseUrl,
  WEB_ORIGIN: 'https://inkroom.example.com',
};

describe('loadConfig', () => {
  it('applies loopback, port and origin defaults with insecure cookies outside production', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      host: '127.0.0.1',
      port: 21080,
      databaseUrl,
      webOrigin: 'http://127.0.0.1:21173',
      cookieSecure: false,
      logLevel: 'info',
      trustProxy: [],
    });
  });

  it('enables secure cookies by default in production', () => {
    expect(loadConfig({ ...productionEnv }).cookieSecure).toBe(true);
  });

  it('refuses to turn secure cookies off in production', () => {
    expect(() => loadConfig({ ...productionEnv, COOKIE_SECURE: 'false' })).toThrow(
      'COOKIE_SECURE cannot be false in production.',
    );
  });

  it('requires an explicit web origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: databaseUrl })).toThrow(
      'WEB_ORIGIN must be set in production.',
    );
  });

  it('requires an https web origin in production', () => {
    expect(() =>
      loadConfig({ ...productionEnv, WEB_ORIGIN: 'http://inkroom.example.com' }),
    ).toThrow('WEB_ORIGIN must use https:// in production.');
  });

  it('normalizes WEB_ORIGIN to its origin', () => {
    expect(
      loadConfig({ WEB_ORIGIN: 'https://inkroom.example.com/', DATABASE_URL: databaseUrl })
        .webOrigin,
    ).toBe('https://inkroom.example.com');
  });

  it('reads overrides from the environment', () => {
    expect(
      loadConfig({
        API_HOST: '0.0.0.0',
        API_PORT: '21081',
        DATABASE_URL: databaseUrl,
        LOG_LEVEL: 'warn',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 21081,
      databaseUrl,
      webOrigin: 'http://127.0.0.1:21173',
      cookieSecure: false,
      logLevel: 'warn',
      trustProxy: [],
    });
  });

  it('reads the trusted proxy list, ignoring blank entries', () => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, TRUST_PROXY: '172.28.0.0/24, 10.0.0.2,' })
        .trustProxy,
    ).toEqual(['172.28.0.0/24', '10.0.0.2']);
  });

  it('rejects an unknown log level', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose', DATABASE_URL: databaseUrl })).toThrow();
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('rejects a database URL that is not a postgres URL', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/inkroom' }),
    ).toThrow();
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ API_PORT: '70000', DATABASE_URL: databaseUrl })).toThrow();
  });
});
