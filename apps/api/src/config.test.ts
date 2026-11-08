import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const databaseUrl = 'postgres://inkroom:inkroom@127.0.0.1:21432/inkroom';

describe('loadConfig', () => {
  it('applies loopback, port and origin defaults with insecure cookies outside production', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      host: '127.0.0.1',
      port: 21080,
      databaseUrl,
      webOrigin: 'http://127.0.0.1:21173',
      cookieSecure: false,
    });
  });

  it('enables secure cookies by default in production', () => {
    expect(loadConfig({ NODE_ENV: 'production', DATABASE_URL: databaseUrl }).cookieSecure).toBe(
      true,
    );
  });

  it('lets COOKIE_SECURE override the production default', () => {
    expect(
      loadConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'false', DATABASE_URL: databaseUrl })
        .cookieSecure,
    ).toBe(false);
  });

  it('normalizes WEB_ORIGIN to its origin', () => {
    expect(
      loadConfig({ WEB_ORIGIN: 'https://inkroom.example.com/', DATABASE_URL: databaseUrl })
        .webOrigin,
    ).toBe('https://inkroom.example.com');
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      API_HOST: '0.0.0.0',
      API_PORT: '21081',
      DATABASE_URL: databaseUrl,
    });
    expect(config).toEqual({ host: '0.0.0.0', port: 21081, databaseUrl });
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('rejects out-of-range ports', () => {
    expect(() => loadConfig({ API_PORT: '70000', DATABASE_URL: databaseUrl })).toThrow();
  });
});
