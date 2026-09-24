import { Link } from 'wouter';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

const OPERATOR_NAME = 'admin';

const EFFECTIVE_DATE = 'September 19, 2026';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-serif text-xl">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}

export function TermsOfService() {
  return (
    <div className="mx-auto max-w-[800px] px-5 py-8 pb-28 md:px-10 md:py-14" data-testid="page-terms">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-bold uppercase tracking-wider hover:bg-accent"
      >
        <ArrowLeft size={14} /> Back to app
      </Link>

      <h1 className="mt-6 font-serif text-4xl tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-xs text-muted-foreground">
        Effective date: {EFFECTIVE_DATE} · Operated by {OPERATOR_NAME} · Contact: use the{" "}
        <strong>“Report a problem”</strong> button in the app footer.
      </p>

      <Section title="1. What this app is">
        <p>
          Kotoba Cabinet (“MyKotoba”) is an <strong>unofficial</strong> Japanese vocabulary and JLPT
          practice app. It is <strong>not affiliated with or endorsed by</strong> the Japan
          Foundation or JEES. All questions, scripts, and audio are original practice material.
        </p>
      </Section>

      <Section title="2. Your account">
        <p>
          Accounts are created and activated centrally by the administrator — there is no self
          sign-up. To request an account, please contact the administrator.
        </p>
        <p>
          You are responsible for
          keeping your password safe or any other personal information. Please do not use anything abusive, illegal, or that you do not have the right to share. We may remove content or suspend accounts that break these rules.
        </p>
      </Section>

      <Section title="3. Your content">
        <p>
          Nicknames, custom words, and leaderboard entries you create remain yours. By posting them,
          you give us permission to store and display them so the app works (for example, showing
          your nickname on the leaderboard or to your friends). Do not post anything abusive,
          illegal, or that you do not have the right to share. We may remove content or suspend
          accounts that break these rules.
        </p>
      </Section>

      <Section title="4. Scores are practice estimates, not official results">
        <p>
          Scores, pass/fail verdicts (合否), and benchmarks shown in the app are practice
          approximations. The real JLPT scales scores with a method (IRT) the organisers never
          publish, so our numbers can never equal an official result. Do not treat them as one.
        </p>
      </Section>

      <Section title="5. Acceptable use">
        <p>
          Do not abuse the service: no spam, harassment, cheating on leaderboards, scraping other
          users’ data, attacking the service, or breaking the law. One account per person.
        </p>
      </Section>

      <Section title="6. Availability and liability">
        <p>
          The app is provided “as is”, without warranties. We may change, pause, or discontinue it
          at any time. To the maximum extent allowed by law, we are not liable for any damages,
          including exam outcomes, lost study data, or service interruptions.
        </p>
      </Section>

      <Section title="7. Changes to these terms">
        <p>
          We may update these terms; the new version will be posted on this page with a new
          effective date. Continuing to use the app after changes means you accept them.
        </p>
      </Section>

      <Section title="8. Attribution">
        <p>
          Unofficial app. Not affiliated with or endorsed by the Japan Foundation / JEES. JLPT is their trademark. 
          Vocabulary data by Jamie Sinclair (MIT) open-anki-jlpt-decks. ccounts are registered centrally by the administrator
        </p>
      </Section>

      <Section title="9. Contact">
        <p>
          Questions, takedown requests, or reports of abuse: use the{" "}
          <strong>“Report a problem”</strong> button in the footer of any page in the app. Your
          report is stored securely and read by the administrator.
        </p>
      </Section>
    </div>
  );
}
