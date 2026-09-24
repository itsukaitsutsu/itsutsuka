import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { auth } from '@/utils/firebase/client';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';

// Landing page for the Firebase "password reset" email action link.
// The link carries an `oobCode` query param (one-time out-of-band code).
// Set the action URL in Firebase Console -> Authentication -> Templates ->
// Password reset -> "customize action URL" to: https://<your-domain>/reset-password
export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const oobCode = new URLSearchParams(search).get('oobCode') ?? '';

  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [codeState, setCodeState] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  // Validate the reset link on load so an expired or tampered link shows a
  // clear message instead of a form that can never succeed.
  useEffect(() => {
    if (!oobCode) {
      setCodeState('invalid');
      return;
    }
    verifyPasswordResetCode(auth, oobCode)
      .then((accountEmail) => {
        setEmail(accountEmail);
        setCodeState('valid');
      })
      .catch(() => setCodeState('invalid'));
  }, [oobCode]);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setMessage('Password updated! Redirecting to login...');
      setTimeout(() => setLocation('/login'), 2000);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  if (codeState === 'checking') {
    return (
      <div className="mx-auto max-w-sm px-5 py-20">
        <p className="text-sm text-muted-foreground">Checking your reset link...</p>
      </div>
    );
  }

  if (codeState === 'invalid') {
    return (
      <div className="mx-auto max-w-sm space-y-4 px-5 py-20">
        <h1 className="font-serif text-3xl">Set new password</h1>
        <p className="text-sm text-red-500">
          This reset link is invalid or has expired. Please request a new one.
        </p>
        <p className="text-sm text-muted-foreground">
          <Link href="/forgot-password" className="font-semibold text-[hsl(var(--secondary))]">
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm px-5 py-20">
      <form onSubmit={handleUpdate} className="space-y-4">
        <h1 className="font-serif text-3xl">Set new password</h1>
        {email && <p className="text-sm text-muted-foreground">For account: {email}</p>}
        <input
          type="password"
          placeholder="New password (min 6 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {message && <p className="text-sm text-green-600">{message}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-[hsl(var(--primary))] py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]"
        >
          {loading ? 'Updating...' : 'Update password'}
        </button>
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="font-semibold text-[hsl(var(--secondary))]">
            Back to log in
          </Link>
        </p>
      </form>
    </div>
  );
}
