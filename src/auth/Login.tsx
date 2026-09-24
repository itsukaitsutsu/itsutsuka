import { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { auth } from '@/utils/firebase/client';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { Eye, EyeOff, ShieldCheck } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT REGISTRATION — there is no self sign-up.
// Accounts are created centrally by the administrator (same as nihongo.zemetia.com).
// The admin's contact details are deliberately NOT shown here — learners are just
// pointed to the administrator. Change the wording below if you ever want to.
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_NAME = 'administrator';

// Firebase throws long machine codes (e.g. "Firebase: Error (auth/invalid-credential)").
// Turn the common ones into plain English.
function explainAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Email or password is incorrect. If you have never had an account, it has to be created by the administrator first.';
    case 'auth/invalid-email':
      return 'That email address does not look valid.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection and try again.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact the administrator.';
    default: {
      const message = (err as Error)?.message || 'Something went wrong while logging in.';
      // Never show raw "Firebase: Error (auth/xyz)." strings to a learner.
      if (message.startsWith('Firebase:')) {
        return `Could not log in. Please try again — and contact the ${ADMIN_NAME} if it keeps failing.`;
      }
      return message;
    }
  }
}

export default function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      setLocation('/');
    } catch (err: any) {
      setError(explainAuthError(err));
    }
    setLoading(false);
  };

  return (
    <div className="mx-auto max-w-sm px-5 py-20">
      <p className="mono-label text-muted-foreground">Welcome back • おかえりなさい</p>
      <h1 className="mt-2 font-serif text-3xl">Log in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in to keep your daily bonus, word lists and quiz history in sync.
      </p>

      <form onSubmit={handleLogin} className="mt-8 space-y-4">
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" data-testid="input-email" />
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-11 w-full rounded-xl border border-border bg-background px-3 pr-11 text-sm"
            data-testid="input-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            data-testid="button-toggle-password"
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </div>
        <p className="text-right text-sm">
          <Link href="/forgot-password" className="font-semibold text-[hsl(var(--secondary))]">Forgot password?</Link>
        </p>
        {error && <p className="text-sm text-red-500" data-testid="text-login-error">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-xl bg-[hsl(var(--primary))] py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-login">
          {loading ? 'Logging in...' : 'Log in'}
        </button>
      </form>

      {/* No self sign-up: the administrator creates the account (no contact details shown). */}
      <section className="mt-8 rounded-2xl border border-dashed border-border bg-muted/40 p-5" data-testid="notice-admin-registration">
        <p className="flex items-center gap-2 font-bold">
          <ShieldCheck size={16} className="text-[hsl(var(--secondary))]" />
          Don't have an account yet?
        </p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Accounts are registered centrally by the {ADMIN_NAME},
          so please contact the {ADMIN_NAME} to have your account created and activated before
          you log in.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          By logging in you agree to our <Link href="/terms" className="font-semibold underline">Terms of Service</Link> and{' '}
          <Link href="/privacy" className="font-semibold underline">Privacy Policy</Link>.
        </p>
      </section>
    </div>
  );
}
