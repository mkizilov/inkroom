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
import { apiRequest } from '../api/client';

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  login(input: LoginRequest): Promise<void>;
  register(input: RegisterRequest): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    apiRequest('/api/auth/me')
      .then((payload) => {
        if (active) {
          setState({ status: 'authenticated', user: authResponseSchema.parse(payload).user });
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: 'anonymous' });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (input: LoginRequest) => {
    const payload = await apiRequest('/api/auth/login', { method: 'POST', body: input });
    setState({ status: 'authenticated', user: authResponseSchema.parse(payload).user });
  }, []);

  const register = useCallback(async (input: RegisterRequest) => {
    const payload = await apiRequest('/api/auth/register', { method: 'POST', body: input });
    setState({ status: 'authenticated', user: authResponseSchema.parse(payload).user });
  }, []);

  const logout = useCallback(async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    setState({ status: 'anonymous' });
  }, []);

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
