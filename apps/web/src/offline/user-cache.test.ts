import { afterEach, describe, expect, it } from 'vitest';
import { forgetUser, recalledUser, rememberUser } from './user-cache';

const user = {
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'ada@example.com',
  displayName: 'Ada',
};

describe('remembered user', () => {
  afterEach(() => {
    forgetUser();
  });

  it('remembers the last signed-in user until it is forgotten', () => {
    rememberUser(user);
    expect(recalledUser()).toEqual(user);

    forgetUser();
    expect(recalledUser()).toBeNull();
  });

  it('treats a corrupted entry as no signed-in user', () => {
    localStorage.setItem('inkroom.lastUser', '{not json');

    expect(recalledUser()).toBeNull();
  });
});
