import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeft } from 'lucide-react';

// ⚠️ SETUP (do once): replace the 2 lines below with your real details.
const OPERATOR_NAME = 'admin';
const CONTACT_EMAIL = 'tousakuhikari@gmail.com'; // e.g. 'hello@example.com'

const EFFECTIVE_DATE = 'September 19, 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-serif text-xl">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}

export function PrivacyPolicy() {
  return (
    <div className="mx-auto max-w-[800px] px-5 py-8 pb-28 md:px-10 md:py-14" data-testid="page-privacy">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-bold uppercase tracking-wider hover:bg-accent"
      >
        <ArrowLeft size={14} /> Back to app
      </Link>

      <h1 className="mt-6 font-serif text-4xl tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-xs text-muted-foreground">
        Effective date: {EFFECTIVE_DATE} · Operated by {OPERATOR_NAME} · Contact:{' '}
        <a className="font-semibold underline" href={`mailto:${CONTACT_EMAIL}`}>
          {CONTACT_EMAIL}
        </a>
      </p>

      <Section title="1. Data we collect">
        <p>
          <strong>Account:</strong> your email address, handled by cloud-based platform Authentication when you
          sign up / sign in.
        </p>
        <p>
          <strong>App data:</strong> your word lists, custom words,
          quiz history, private card-discovery progress (Seen/New status for practice and reviewed cards, including resets and revision metadata for synchronization), nickname, friend invites/requests, and leaderboard statistics — leaderboard
          entries are only created if you enable score sharing. CSV imports are parsed in your
          browser; resulting saved lists and custom word entries are synced to your account,
          but the uploaded CSV file itself is not stored as a file.
        </p>
        <p>
          <strong>On your device:</strong> quiz history, account-specific card-discovery caches, and preferences in your browser’s local
          storage (stays on your device unless you use an account-synced feature).
        </p>
      </Section>

      <Section title="2. Third-party services">
        <p>
          <strong>Google cloud-based platform</strong> : runs our login and database;
          your data is stored on Google Cloud under Google’s terms.
        </p>
        <p>
          <strong>Google Fonts:</strong> the app loads the Inter font from Google’s servers, which
          receive your IP address when the font loads.
        </p>
        <p>As of the effective date above, the app uses no advertising SDKs and no analytics SDKs.</p>
      </Section>

      <Section title="3. How we use your data">
        <p>
          Only to operate the app: keep you signed in, sync your study data across your devices, and
          run the leaderboard / friends features you choose to use. We do not sell your data.
        </p>
      </Section>

      <Section title="4. Your rights and deletion">
        <p>
          You can ask for a copy, correction, or deletion of your data at any time by emailing{' '}
          <a className="font-semibold underline" href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . On verified deletion requests we remove your data (profile, lists, words,
          card-discovery records, leaderboard, nicknames) within 30 days. Data in your browser’s local storage can be
          cleared by you at any time via your browser settings.
        </p>
      </Section>

      <Section title="5. Changes">
        <p>
          We may update this policy; the new version will be posted on this page with a new
          effective date.
        </p>
      </Section>
    </div>
  );
}
