import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { api, explainApiError } from '@/lib/api';

type Category = 'bug' | 'wrong_answer' | 'typo' | 'other';

const CATEGORY_LABELS: Record<Category, string> = {
  bug: 'Something is broken or shows an error',
  wrong_answer: 'A wrong answer, reading, or meaning',
  typo: 'A spelling or grammar mistake',
  other: 'Something else',
};

/**
 * "Report a problem" — a small button that opens a feedback form.
 * Posts to POST /api/feedback, which stores the report in D1 (no email involved).
 * The button matches the footer's link style, so it fits in the legal row.
 */
export function ReportProblemButton({ label = 'Report a problem' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>('bug');
  const [page, setPage] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const openDialog = () => {
    // Pre-fill with the current page so the user doesn't have to think about it.
    setPage(window.location.pathname);
    setOpen(true);
  };

  const closeAndReset = () => {
    setOpen(false);
    setCategory('bug');
    setPage('');
    setMessage('');
  };

  const submit = async () => {
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.sendFeedback({ category, page: (page || window.location.pathname).trim(), message: text });
      toast({
        title: 'Thank you!',
        description: 'Your report was sent. It will be looked at in a future update.',
      });
      closeAndReset();
    } catch (err) {
      toast({
        title: 'Could not send your report',
        description: explainApiError(err),
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        data-testid="footer-link-feedback"
      >
        {label}
      </button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeAndReset())}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Report a problem</DialogTitle>
            <DialogDescription>
              Found a bug, a wrong answer, or a spelling mistake? Tell us what you saw — it really
              helps.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>What kind of problem is it?</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as Category)}>
                <SelectTrigger data-testid="feedback-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(CATEGORY_LABELS) as Category[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {CATEGORY_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="feedback-page">Where did you notice it? (optional)</Label>
              <Input
                id="feedback-page"
                value={page}
                onChange={(e) => setPage(e.target.value)}
                placeholder="e.g. N3 mock exam, listening question 5"
                data-testid="feedback-page"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="feedback-message">What happened?</Label>
              <Textarea
                id="feedback-message"
                rows={4}
                maxLength={2000}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Example: the answer shown for this question should be…"
                data-testid="feedback-message"
              />
              <p className="text-xs text-muted-foreground">{message.length}/2000</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAndReset} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={sending || !message.trim()} data-testid="feedback-submit">
              {sending ? 'Sending…' : 'Send report'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
