import { presenceStateSchema, type Awareness, type PresenceState } from '@inkroom/shared';

export interface Participant {
  clientId: number;
  isSelf: boolean;
  state: PresenceState;
}

// Everyone currently present, this client first. A remote state that does not validate is left out,
// so a damaged state cannot break the toolbar or the overlay.
export function participantsOf(awareness: Awareness): Participant[] {
  const participants: Participant[] = [];
  const local = presenceStateSchema.safeParse(awareness.getLocalState());
  if (local.success) {
    participants.push({ clientId: awareness.clientID, isSelf: true, state: local.data });
  }
  for (const { clientId, state } of awareness.remoteStates()) {
    const parsed = presenceStateSchema.safeParse(state);
    if (parsed.success) {
      participants.push({ clientId, isSelf: false, state: parsed.data });
    }
  }
  return participants;
}
