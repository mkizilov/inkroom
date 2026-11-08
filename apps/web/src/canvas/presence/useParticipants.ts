import { useMemo, useSyncExternalStore } from 'react';
import type { Awareness } from '@inkroom/shared';
import { participantsOf, type Participant } from './participants';

// Re-renders when anyone's presence changes, and returns the current participants.
export function useParticipants(awareness: Awareness): Participant[] {
  const version = useSyncExternalStore(awareness.subscribe, () => awareness.version);
  // `version` is not read by the callback, but a new version means the awareness state changed, so the
  // participants must be rebuilt. The lint rule cannot see that the awareness object is mutable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => participantsOf(awareness), [awareness, version]);
}
