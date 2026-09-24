import { Link } from 'wouter';

// Site footer (legal-bar edition).
// The credits + "unofficial app" notice must stay: the vocabulary data is MIT
// licensed and requires attribution (see ATTRIBUTION.md).
export function CreditsFooter() {
  return (
    <footer className="app-sidebar-offset border-t border-border bg-background/50 px-6 py-10 md:ml-[246px] md:px-12" data-testid="credits-footer">
      <div className="mx-auto max-w-[1100px]">
        {/* Standalone Copyright */}
        <p className="text-sm font-semibold text-foreground">
          © mykotoba 2026 (マイ言葉). All rights reserved.
        </p>

        {/* Legal links row — internal pages, so wouter <Link>, not <a> */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-x-4 gap-y-1 border-t border-border/60 pt-4 text-xs font-semibold">
          <Link
            href="/terms"
            className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            data-testid="footer-link-terms"
          >
            Terms of Service
          </Link>
          <span aria-hidden="true" className="text-border">•</span>
          <Link
            href="/privacy"
            className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            data-testid="footer-link-privacy"
          >
            Privacy Policy
          </Link>
        </div>
      </div>
    </footer>
  );
}
