import { ReactNode } from 'react';
import { Redirect } from 'wouter';
import { useAuth } from './useAuth';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  // This optional Vite-only flag is for the local visual preview server. It is
  // never active in production builds, so deployed routes still require login.
  if (import.meta.env.DEV && import.meta.env.VITE_WINTER_ARCHIVE_PREVIEW === '1') return <>{children}</>;

  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}