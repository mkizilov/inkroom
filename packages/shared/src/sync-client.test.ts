import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { SyncClient } from './sync-client';
import { encodeRole } from './sync-protocol';

describe('SyncClient role frames', () => {
  it('reports a role change to onRole, and answers it with nothing', () => {
    const roles: string[] = [];
    const client = new SyncClient({
      doc: new Y.Doc(),
      remoteOrigin: Symbol('remote'),
      onRole: (role) => roles.push(role),
    });

    expect(client.receive(encodeRole('viewer'))).toEqual([]);
    expect(roles).toEqual(['viewer']);
  });
});
