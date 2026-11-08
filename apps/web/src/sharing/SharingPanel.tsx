import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  grantableRoleSchema,
  inviteMemberSchema,
  type BoardRole,
  type GrantableRole,
  type Member,
} from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { roleLabels } from '../boards/format';
import { TextField } from '../components/TextField';
import { changeMemberRole, fetchMembers, inviteMember, removeMember } from './api';

interface SharingPanelProps {
  boardId: string;
  role: BoardRole;
  currentUserId?: string;
}

type MembersState =
  | { kind: 'loading' }
  | { kind: 'loaded'; items: Member[] }
  | { kind: 'error'; message: string };

function asGrantable(value: string): GrantableRole | undefined {
  const parsed = grantableRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// Who has access to the board, and what the caller may change. Only the owner can invite, change
// roles and remove people; any member can leave. The server enforces both, and these controls only
// offer what it will accept.
export function SharingPanel({ boardId, role, currentUserId }: SharingPanelProps) {
  const navigate = useNavigate();
  const isOwner = role === 'owner';
  const [members, setMembers] = useState<MembersState>({ kind: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<GrantableRole>('viewer');
  const [emailError, setEmailError] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setMembers({ kind: 'loaded', items: await fetchMembers(boardId) });
    } catch (error) {
      setMembers({ kind: 'error', message: describeError(error) });
    }
  }, [boardId]);

  useEffect(() => {
    load();
  }, [load]);

  // Runs one change, then shows the list as the server now holds it.
  async function change(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (error) {
      setActionError(describeError(error));
    }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = inviteMemberSchema.safeParse({ email, role: inviteRole });
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message);
      return;
    }
    setEmailError(undefined);
    await change(async () => {
      await inviteMember(boardId, parsed.data.email, parsed.data.role);
      setEmail('');
    });
  }

  async function handleLeave(userId: string) {
    setActionError(null);
    try {
      await removeMember(boardId, userId);
      navigate('/');
    } catch (error) {
      setActionError(describeError(error));
    }
  }

  return (
    <section aria-label="Sharing" className="panel">
      <h2>Sharing</h2>
      {members.kind === 'loading' && <p role="status">Loading members…</p>}
      {members.kind === 'error' && (
        <p role="alert" className="form-error">
          {members.message}
        </p>
      )}
      {members.kind === 'loaded' && (
        <ul aria-label="Members" className="member-list">
          {members.items.map((member) => {
            const isSelf = member.userId === currentUserId;
            const canChange = isOwner && member.role !== 'owner';
            return (
              <li key={member.userId} className="member-row">
                <span>
                  {member.displayName}
                  {isSelf ? ' (you)' : ''}
                </span>
                {member.email && <span className="member-email">{member.email}</span>}
                {canChange ? (
                  <select
                    aria-label={`Role for ${member.displayName}`}
                    value={member.role}
                    onChange={(event) => {
                      const next = asGrantable(event.target.value);
                      if (next) {
                        change(() => changeMemberRole(boardId, member.userId, next));
                      }
                    }}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  <span className="role-badge">{roleLabels[member.role]}</span>
                )}
                {canChange && (
                  <button
                    type="button"
                    onClick={() => change(() => removeMember(boardId, member.userId))}
                  >
                    Remove {member.displayName}
                  </button>
                )}
                {!isOwner && isSelf && (
                  <button type="button" onClick={() => handleLeave(member.userId)}>
                    Leave board
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {isOwner && (
        <form aria-label="Invite people" onSubmit={handleInvite} noValidate className="inline-form">
          <TextField
            id="invite-email"
            label="Email address"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            error={emailError}
          />
          <label htmlFor="invite-role">Role</label>
          <select
            id="invite-role"
            value={inviteRole}
            onChange={(event) => setInviteRole(asGrantable(event.target.value) ?? inviteRole)}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button type="submit">Invite</button>
        </form>
      )}
      {actionError && (
        <p role="alert" className="form-error">
          {actionError}
        </p>
      )}
    </section>
  );
}
