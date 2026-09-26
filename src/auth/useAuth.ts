import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { auth } from '@/utils/firebase/client';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { api, clearDeviceSessionId, deviceSessionId } from '@/lib/api';

// ONE auth listener for the whole app, shared through context.
// Before, every component that called useAuth() created its own Firebase
// listener; they fired in different orders on logout, so <ProtectedRoute>
// could unmount the header while the Log out button was still mid-click.
type AuthState = { user: User | null; loading: boolean; logout: () => Promise<void> };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Register this browser session promptly and notice remote revocation even if
  // the user is idle on a screen that makes no other API requests.
  useEffect(() => {
    if (!user) return;
    const verify = () => { void api.checkDeviceSession().catch(() => undefined); };
    verify();
    const timer = window.setInterval(verify, 60_000);
    return () => window.clearInterval(timer);
  }, [user?.uid]);

  const logout = async () => {
    const uid = auth.currentUser?.uid;
    if (uid) await api.revokeDevice(deviceSessionId(uid)).catch(() => undefined);
    await signOut(auth);
    clearDeviceSessionId(uid);
  };

  return createElement(AuthContext.Provider, { value: { user, loading, logout } }, children);
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
