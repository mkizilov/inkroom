import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  authResponseSchema,
  type AuthUser,
  type LoginRequest,
  type RegisterRequest,
} from '@inkroom/shared';
import { ApiError, apiRequest } from '../api/client';
import { browserLocalStore } from '../offline/indexeddb-store';
import { forgetUser, recalledUser, rememberUser } from '../offline/user-cache';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  // `offline` means the server could not be reached, so this is the user who last signed in here.
  | { status: 'authenticated'; user: AuthUser; offline?: boolean };

interface AuthContextValue {
  state: AuthState;
  login(input: LoginRequest): Promise<void>;
  register(input: RegisterRequest): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // Asks the server who is signed in. When the server cannot be reached, the user who last signed in
  // on this device stays signed in, so the boards kept here can still be opened. The check runs again
  // when the browser comes back online.
  const refresh = useCallback(() => {
    apiRequest('/api/auth/me')
      .then((payload) => {
        const user = authResponseSchema.parse(payload).user;
        rememberUser(user);
        setState({ status: 'authenticated', user });
      })
      .catch((error: unknown) => {
        const unreachable = error instanceof ApiError && error.status === 0;
        const cached = unreachable ? recalledUser() : null;
        if (cached) {
          setState({ status: 'authenticated', user: cached, offline: true });
          return;
        }
        if (!unreachable) {
          forgetUser();
        }
        setState({ status: 'anonymous' });
      });
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [refresh]);

  const login = useCallback(async (input: LoginRequest) => {
    const payload = await apiRequest('/api/auth/login', { method: 'POST', body: input });
    const user = authResponseSchema.parse(payload).user;
    rememberUser(user);
    setState({ status: 'authenticated', user });
  }, []);

  const register = useCallback(async (input: RegisterRequest) => {
    const payload = await apiRequest('/api/auth/register', { method: 'POST', body: input });
    const user = authResponseSchema.parse(payload).user;
    rememberUser(user);
    setState({ status: 'authenticated', user });
  }, []);

  // Signing out deletes this user's copies of boards from this device. Changes that have not reached
  // the server are deleted with them, so sign out once the browser is back online.
  const logout = useCallback(async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    if (state.status === 'authenticated') {
      await browserLocalStore()?.removeUser(state.user.id);
    }
    forgetUser();
    setState({ status: 'anonymous' });
  }, [state]);

  const value = useMemo(
    () => ({ state, login, register, logout }),
    [state, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
