import { act } from '@testing-library/react';

/**
 * Poll until `check()` stops throwing.
 *
 * Drop-in replacement for testing-library's `waitFor`, which stalls in this app:
 * once the quiz timer and the discovery provider's promise chains are in flight,
 * `waitFor`'s internal interval stops resuming, so it times out even though the
 * UI has already updated. Sleeping inside `act()` lets React flush those updates,
 * so the assertion sees them on the next tick.
 */
export async function eventually(check: () => void, timeout = 8000): Promise<void> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) throw lastError;
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    });
  }
}
