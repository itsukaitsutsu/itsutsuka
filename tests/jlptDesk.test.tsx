// The JLPT desk groups three destinations — JLPT exam, JLPT simulation and
// My words — on one page behind one nav button named "JLPT". These tests pin
// that contract down: a single sidebar entry, three tabs, and legacy URLs
// (/exam, /jlpt-simulation, /custom) that land on the matching tab with their
// query flags intact.
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import App from '@/App';

vi.mock('@/lib/api', () => import('../tests/helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('../tests/helpers/fakeApi');
  return {
    useAuth: () => ({ user: fake.uid ? { uid: fake.uid, email: 'learner@example.com' } : null, loading: false, logout: vi.fn() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/utils/firebase/client', () => ({ auth: {}, db: {} }));

const { fake, resetFake } = await import('../tests/helpers/fakeApi');

function navigate(path: string) { window.history.pushState({}, '', path); }
/** Navigate after render: wouter reacts to the patched pushState, but React needs a flush. */
async function goto(path: string) { await act(async () => { navigate(path); }); }

describe('JLPT desk', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    resetFake({ lists: [{ id: 'default-slot', name: 'Slot 1', wordIds: [], createdAt: '2026-01-01' }], activeId: 'default-slot', customWords: [], history: [] });
    fake.uid = 'learner';
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); });

  it('replaces the three old sidebar entries with one JLPT button', async () => {
    navigate('/'); render(<App />);
    expect(screen.getByTestId('nav-jlpt').textContent).toContain('JLPT');
    expect(screen.queryByTestId('nav-jlpt-exam')).toBeNull();
    expect(screen.queryByTestId('nav-jlpt-simulation')).toBeNull();
    expect(screen.queryByTestId('nav-my-words')).toBeNull();
  });

  it('shows all three sections as tabs on one page', async () => {
    await goto('/jlpt'); render(<App />);
    expect(screen.getByTestId('page-jlpt')).toBeTruthy();
    expect(screen.getByTestId('jlpt-tab-exam')).toBeTruthy();
    expect(screen.getByTestId('jlpt-tab-simulation')).toBeTruthy();
    expect(screen.getByTestId('jlpt-tab-words')).toBeTruthy();
    // Default tab is the practice exam.
    expect(screen.getByTestId('page-jlpt-exam')).toBeTruthy();
    fireEvent.click(screen.getByTestId('jlpt-tab-simulation'));
    await waitFor(() => expect(screen.getByTestId('page-jlpt-simulation')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt?tab=simulation');
    fireEvent.click(screen.getByTestId('jlpt-tab-words'));
    await waitFor(() => expect(screen.getByTestId('page-custom-words')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt?tab=words');
    fireEvent.click(screen.getByTestId('jlpt-tab-exam'));
    await waitFor(() => expect(screen.getByTestId('page-jlpt-exam')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt');
  });

  it('sends legacy URLs to the matching tab, keeping query flags', async () => {
    render(<App />);
    await goto('/exam?review=1');
    await waitFor(() => expect(screen.getByTestId('page-jlpt-exam')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt?review=1');
    await goto('/jlpt-simulation');
    await waitFor(() => expect(screen.getByTestId('page-jlpt-simulation')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt?tab=simulation');
    await goto('/custom');
    await waitFor(() => expect(screen.getByTestId('page-custom-words')).toBeTruthy());
    expect(window.location.pathname + window.location.search).toBe('/jlpt?tab=words');
  });
});
