import { useMemo, useSyncExternalStore } from 'react';
import type { Awareness } from '@inkroom/shared';
import { participantsOf, type Participant } from './participants';

// Re-renders when anyone's presence changes, and returns the current participants.
export function useParticipants(awareness: Awareness): Participant[] {
  const version = useSyncExternalStore(awareness.subscribe, () => awareness.version);
  return useMemo(() => participantsOf(awareness), [awareness, version]);
}
