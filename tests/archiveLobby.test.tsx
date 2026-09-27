import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';

vi.mock('@/lib/api', () => import('./helpers/fakeApi'));
vi.mock('@/auth/useAuth', async () => {
  const { fake } = await import('./helpers/fakeApi');
  return {
    useAuth: () => ({ user: fake.uid ? { uid: fake.uid, email: 'learner@example.com' } : null, loading: false, logout: vi.fn() }),
    AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock('@/utils/firebase/client', () => ({ auth: {}, db: {} }));

const { fake, resetFake } = await import('./helpers/fakeApi');

function navigate(path: string) { window.history.pushState({}, '', path); }
async function goto(path: string) { await act(async () => { navigate(path); }); }

describe('Winter Archive lobby', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    resetFake({
      lists: [{ id: 'default-slot', name: 'My words', wordIds: [], createdAt: '2026-01-01' }],
      activeId: 'default-slot',
      customWords: [],
      history: [],
    });
    fake.uid = 'learner';
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    navigate('/');
  });
  afterEach(() => cleanup());

  it('shows the real app navigation, mode selector, mission status and vocabulary card', async () => {
    render(<App />);
    expect(await screen.findByTestId('archive-lobby')).toBeTruthy();
    expect(screen.getByTestId('archive-rail-review').getAttribute('href')).toBe('/review');
    expect(screen.getByTestId('archive-rail-cabinet').getAttribute('href')).toBe('/cabinet');
    expect(screen.getByTestId('home-mode-ranked').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('archive-mission-link').getAttribute('href')).toBe('/bonus');
    const missionWrap = screen.getByTestId('archive-mission-wrap');
    expect(missionWrap.parentElement?.classList.contains('archive-lobby__header')).toBe(true);
    expect(missionWrap.previousElementSibling?.classList.contains('archive-lobby__brand-group')).toBe(true);
    expect(missionWrap.previousElementSibling?.querySelector('[data-testid="link-logo"]')).toBeTruthy();
    expect(missionWrap.querySelector('[data-testid="link-logo"]')).toBeNull();
    expect(screen.getByTestId('archive-word-card').textContent).toMatch(/[\p{Script=Han}\p{Script=Hiragana}]/u);
    expect(screen.getByTestId('archive-action-results').getAttribute('href')).toBe('/results');
    expect(screen.getByTestId('archive-action-jlpt-simulation').getAttribute('href')).toBe('/jlpt-simulation');
    expect(screen.getByTestId('archive-action-jlpt-simulation').textContent).toContain('JLPT simulation');
    expect(screen.queryByTestId('archive-action-progress')).toBeNull();
  });

  it('selects a real mode and deploys to the existing quiz setup route', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    fireEvent.click(screen.getByTestId('home-mode-casual'));
    expect(screen.getByTestId('home-mode-casual').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('home-deploy'));
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/quiz?setup=casual'));
  });

  it('opens the live mission list on hover and closes it when the pointer leaves', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    const wrapper = screen.getByTestId('archive-mission-wrap');
    const preview = screen.getByTestId('archive-mission-preview');
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    fireEvent.mouseEnter(wrapper);
    expect(preview.getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('bonus-task-warmup')).toBeTruthy();
    expect(screen.getByTestId('button-task-warmup').getAttribute('href')).toBe('/quiz');
    fireEvent.mouseLeave(wrapper);
    expect(preview.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens the mission preview from its touch-friendly toggle', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    fireEvent.click(screen.getByTestId('archive-mission-toggle'));
    expect(screen.getByTestId('archive-mission-preview').getAttribute('aria-hidden')).toBe('false');
  });

  it('supports the number-key mode shortcuts and Enter deploys the selected path', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByTestId('home-mode-casual').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(window, { key: 'Enter' });
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/quiz?setup=casual'));
  });

  it('opens the complete mobile menu and reaches a real feature page', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    fireEvent.click(screen.getByTestId('button-home-menu'));
    fireEvent.click(await screen.findByTestId('mobile-nav-card-library'));
    await waitFor(() => expect(window.location.pathname).toBe('/review'));
  });
});
