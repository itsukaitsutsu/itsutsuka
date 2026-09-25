import { useState } from 'react';
import { useLocation, useSearch, Link } from 'wouter';
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
  const search = useSearch();
  const requestedNext = new URLSearchParams(search).get('next');
  const next = requestedNext && /^\/(?![\\/])/.test(requestedNext) ? requestedNext : '/lobby';
  const interfacePreview = import.meta.env.DEV && import.meta.env.VITE_FIREBASE_API_KEY === 'local-interface-preview';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (interfacePreview) { setError('This interface preview is not connected to Firebase. Your deployed app keeps its existing sign-in.'); return; }
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      setLocation(next);
    } catch (err: any) {
      setError(explainAuthError(err));
    }
    setLoading(false);
  };

  return (
    <div className="winter-login">
      <aside className="login-story">
        <span>YOUR PLACE IN THE WINTER ARCHIVE</span>
        <h2>The next chapter<br />is <em>yours.</em></h2>
        <p>A few new words. A familiar companion. Pick up right where you left off.</p>
        <div className="login-story-mark" lang="ja" aria-hidden="true">言</div>
        <small>一歩ずつ。 &nbsp; ONE STEP AT A TIME.</small>
      </aside>
      <div className="login-form-pane">
      <p className="mono-label text-muted-foreground">Welcome back • おかえりなさい</p>
      <h1 className="mt-2 font-serif text-3xl">Log in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Sign in to keep your daily bonus, word lists and quiz history in sync.
      </p>

      {interfacePreview && <p className="preview-connection-note" role="note">Local interface preview. Account features need your existing Firebase and Cloudflare configuration; no live account connection is active here.</p>}
      <form onSubmit={handleLogin} className="mt-8 space-y-4">
        <label className="login-field-label" htmlFor="login-email">Email address</label>
        <input id="login-email" autoComplete="username" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" data-testid="input-email" />
        <div>
        <label className="login-field-label" htmlFor="login-password">Password</label>
        <div className="relative">
          <input
            id="login-password"
            autoComplete="current-password"
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
        </div></div>
        <p className="text-right text-sm">
          <Link href="/forgot-password" className="font-semibold text-[hsl(var(--secondary))]">Forgot password?</Link>
        </p>
        {error && <p className="text-sm text-red-500" data-testid="text-login-error">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-xl bg-[hsl(var(--primary))] py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]" data-testid="button-login">
          {loading ? 'Logging in...' : 'Log in'}
        </button>
      </form>

      {/* No self sign-up: the administrator creates the account (no contact details shown). */}
      <section className="notice-admin mt-8 rounded-2xl border border-dashed border-border bg-muted/40 p-5" data-testid="notice-admin-registration">
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
      <Link href="/lobby" className="heroes-back">← Back to base camp</Link>
      </div>
    </div>
  );
}
