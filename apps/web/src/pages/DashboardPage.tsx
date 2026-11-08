import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { describeError } from '../auth/messages';
import { ApiStatus } from '../components/ApiStatus';
import { BoardList } from '../boards/BoardList';
import { CreateBoardForm } from '../boards/CreateBoardForm';
import { useBoardList } from '../boards/useBoardList';

export function DashboardPage() {
  const { state, logout } = useAuth();
  const list = useBoardList();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (state.status !== 'authenticated') {
    return null;
  }
  const { user } = state;

  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await logout();
    } catch (error) {
      setSignOutError(describeError(error));
      setSigningOut(false);
    }
  }

  return (
    <main>
      <header className="page-header">
        <div>
          <h1>Your boards</h1>
          <p>
            Signed in as <strong>{user.displayName}</strong> ({user.email})
          </p>
        </div>
        <button type="button" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </header>
      {signOutError && (
        <p role="alert" className="form-error">
          {signOutError}
        </p>
      )}
      <CreateBoardForm onCreate={list.addBoard} />
      <BoardList list={list} />
      <footer className="page-footer">
        <ApiStatus />
      </footer>
    </main>
  );
}
