import { useState } from 'react';
import { Link } from 'wouter';
import { auth } from '@/utils/firebase/client';
import { sendPasswordResetEmail } from 'firebase/auth';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      await sendPasswordResetEmail(auth, email);
      setMessage('Check your email for a password reset link.');
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    <div className="mx-auto max-w-sm px-5 py-20">
      <form onSubmit={handleReset} className="space-y-4">
        <h1 className="font-serif text-3xl">Reset password</h1>
        <p className="text-sm text-muted-foreground">Enter your email and we'll send you a reset link.</p>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm" />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {message && <p className="text-sm text-green-600">{message}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-xl bg-[hsl(var(--primary))] py-3 text-sm font-bold text-[hsl(var(--primary-foreground))]">
          {loading ? 'Sending...' : 'Send reset link'}
        </button>
        <p className="text-sm text-muted-foreground">
          <Link href="/login" className="font-semibold text-[hsl(var(--secondary))]">Back to log in</Link>
        </p>
      </form>
    </div>
  );
}