import { z } from 'zod';
import { colorSchema, pointSchema } from './canvas';

// What one participant publishes about themselves. Cursors are world coordinates, so every client
// can place them on its own canvas, whatever its zoom or pan. The server validates every state
// against this schema before relaying it.
export const presenceUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  color: colorSchema,
});

export const presenceStateSchema = z.object({
  user: presenceUserSchema,
  cursor: pointSchema.nullable(),
  selection: z.array(z.string().uuid()).max(500),
});

export type PresenceUser = z.infer<typeof presenceUserSchema>;
export type PresenceState = z.infer<typeof presenceStateSchema>;

export const PRESENCE_PALETTE: readonly string[] = [
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#f08c00',
  '#9c36b5',
  '#0c8599',
  '#d6336c',
  '#5f3dc4',
];

// The same user gets the same colour on every client, so participants can recognise each other.
// FNV-1a over the user id keeps the mapping stable across browsers and sessions.
export function colorForUser(userId: string): string {
  let hash = 2166136261;
  for (const character of userId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return PRESENCE_PALETTE[hash % PRESENCE_PALETTE.length] ?? '#1f2328';
}
