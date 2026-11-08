import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  objectsMapOf,
  readOrderedObjects,
  serializeBoardExport,
  type CanvasObject,
} from '@inkroom/shared';
import { buildApp } from '../app';
import { issueSession } from '../auth/service';
import { createUser } from '../db/repositories/users';
import {
  createTestDatabase,
  describeWithDatabase,
  testDatabaseUrl,
  type TestDatabase,
} from '../db/test-database';
import { PostgresBoardStore } from '../persistence/store';

const WEB_ORIGIN = 'http://127.0.0.1:21173';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Every object type, with values that are easy to lose on the way: negative and fractional
// coordinates, a fill, pen points, an arrow, and text with markup and a line break.
const exported: CanvasObject[] = [
  {
    id: id(1),
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 60,
    stroke: '#1971c2',
    strokeWidth: 2,
    fill: '#a5d8ff',
  },
  {
    id: id(2),
    type: 'ellipse',
    x: -40,
    y: 5.5,
    width: 80,
    height: 30,
    stroke: '#2f9e44',
    strokeWidth: 3,
  },
  {
    id: id(3),
    type: 'pen',
    x: 200,
    y: 200,
    points: [
      { x: 0, y: 0 },
      { x: 5.25, y: -3 },
      { x: 12, y: 4 },
    ],
    stroke: '#000000',
    strokeWidth: 1,
  },
  { id: id(4), type: 'line', x: 0, y: 0, dx: 120, dy: -45, stroke: '#000000', strokeWidth: 2 },
  { id: id(5), type: 'arrow', x: 300, y: 40, dx: -60, dy: 90, stroke: '#e03131', strokeWidth: 2 },
  {
    id: id(6),
    type: 'text',
    x: 50,
    y: 400,
    text: 'Café <b>"notes"</b>\nline two & more',
    stroke: '#1e1e1e',
    strokeWidth: 1,
    fontSize: 24,
  },
];

const exportedAt = '2026-01-02T09:30:00.000Z';
const exportText = serializeBoardExport({
  title: 'Imported plan',
  objects: exported,
  region: null,
  exportedAt,
});

describeWithDatabase('importing a board over HTTP', () => {
  let database: TestDatabase;
  let app: FastifyInstance;
  let cookie: string;
  let stranger: string;

  beforeAll(async () => {
    database = await createTestDatabase(testDatabaseUrl ?? '');
    ({ app } = await buildApp({
      database,
      webOrigin: WEB_ORIGIN,
      cookieSecure: false,
      startHeartbeat: false,
    }));
    const signIn = async (name: string) => {
      const user = await createUser(database.db, {
        email: `${randomUUID()}@example.com`,
        displayName: name,
        passwordHash: 'test-hash',
      });
      return `inkroom_session=${await issueSession(database.db, user.id)}`;
    };
    cookie = await signIn('Importer');
    stranger = await signIn('Stranger');
  });

  afterAll(async () => {
    await app.close();
    await database.drop();
  });

  function post(body: string, options: { cookie?: string; origin?: string } = {}) {
    return app.inject({
      method: 'POST',
      url: '/api/boards/import',
      headers: {
        origin: options.origin ?? WEB_ORIGIN,
        'content-type': 'application/json',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      payload: body,
    });
  }

  async function boardCount(as: string): Promise<number> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/boards',
      headers: { origin: WEB_ORIGIN, cookie: as },
    });
    return (response.json() as { items: unknown[] }).items.length;
  }

  it('creates a board owned by the importer, with the same objects in the same order', async () => {
    const response = await post(exportText, { cookie });

    expect(response.statusCode).toBe(201);
    const board = (response.json() as { board: { id: string; title: string; role: string } }).board;
    expect(board).toMatchObject({ title: 'Imported plan', role: 'owner' });

    const stored = await new PostgresBoardStore(database.db, () => undefined).load(board.id);
    expect(readOrderedObjects(objectsMapOf(stored)).objects).toEqual(exported);
  });

  it('keeps the imported board private to the importer', async () => {
    const created = (await post(exportText, { cookie })).json() as { board: { id: string } };

    const asStranger = await app.inject({
      method: 'GET',
      url: `/api/boards/${created.board.id}`,
      headers: { origin: WEB_ORIGIN, cookie: stranger },
    });
    expect(asStranger.statusCode).toBe(404);
  });

  it('refuses a version it does not read, and creates nothing', async () => {
    const before = await boardCount(cookie);
    const future = { ...(JSON.parse(exportText) as object), version: 2 };

    const response = await post(JSON.stringify(future), { cookie });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(await boardCount(cookie)).toBe(before);
  });

  it('refuses malformed JSON, and a file that is not a board export', async () => {
    const before = await boardCount(cookie);

    const notJson = await post('{"format":', { cookie });
    const wrongShape = await post(JSON.stringify({ format: 'inkroom.board' }), { cookie });

    expect(notJson.statusCode).toBe(400);
    expect(wrongShape.statusCode).toBe(400);
    expect(wrongShape.json()).toMatchObject({ error: { code: 'validation_failed' } });
    expect(await boardCount(cookie)).toBe(before);
  });

  it('refuses a board with more objects than a board can hold', async () => {
    const many = Array.from({ length: 10_001 }, (_, index) => ({
      id: id(index + 1),
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      stroke: '#000000',
      strokeWidth: 1,
    }));
    const body = JSON.stringify({
      format: 'inkroom.board',
      version: 1,
      title: 'Too many',
      exportedAt,
      region: null,
      objects: many,
    });

    expect((await post(body, { cookie })).statusCode).toBe(400);
  });

  it('refuses a body larger than the import limit before reading it', async () => {
    const oversized = `{"padding":"${'x'.repeat(MAX_IMPORT_BYTES)}"}`;

    expect((await post(oversized, { cookie })).statusCode).toBe(413);
  });

  it('refuses an anonymous import, and a cross-site import before any other check', async () => {
    const anonymous = await post(exportText);
    const crossSite = await post(exportText, { cookie, origin: 'https://evil.example' });

    expect(anonymous.statusCode).toBe(401);
    expect(crossSite.statusCode).toBe(403);
  });
});
