// The lobby is a MOBA-style HUD: no top bar, no side rail, one right-edge
// command rail and a deploy button. These tests pin that contract down so a
// future refactor cannot quietly bring the old navigation back.
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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

describe('MOBA lobby HUD', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    resetFake({ lists: [], activeId: null, customWords: [], history: [] });
    fake.uid = null; // public lobby — a guest must see the same HUD
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    navigate('/lobby');
  });
  afterEach(() => { cleanup(); });

  it('renders the HUD and drops the old navigation chrome', () => {
    const { container } = render(<App />);
    expect(container.querySelector('.winter-topbar')).toBeNull();
    expect(container.querySelector('.winter-rail')).toBeNull();
    expect(container.querySelector('.home-rail')).toBeNull();
    expect(container.querySelector('.moba-hud')).toBeTruthy();
    expect(container.querySelector('.moba-rail')).toBeTruthy();
    expect(container.querySelector('.moba-launch')).toBeTruthy();
    // Identity plate, resource pills and the deploy button all survive the move.
    expect(screen.getByTestId('button-profile-settings')).toBeTruthy();
    expect(screen.getByTestId('button-user-menu')).toBeTruthy();
    expect(container.querySelector('.moba-start__button')?.textContent).toContain('PLAY RANKED');
  });

  it('keeps every destination reachable from the right-edge rail', () => {
    const { container } = render(<App />);
    const rail = container.querySelector('.moba-rail') as HTMLElement;
    const hrefs = [...rail.querySelectorAll('a')].map(a => a.getAttribute('href'));
    for (const path of ['/lobby', '/heroes', '/cabinet', '/custom', '/review', '/quiz', '/jlpt-simulation', '/results', '/leaderboard', '/progress', '/friends', '/bonus']) {
      expect(hrefs).toContain(path);
    }
  });

  it('picks a path with the mode tiles and with the number keys', () => {
    const { container } = render(<App />);
    const start = () => container.querySelector('.moba-start__button') as HTMLElement;
    const tiles = () => [...container.querySelectorAll('.moba-mode')] as HTMLElement[];

    expect(tiles()).toHaveLength(4);
    fireEvent.click(tiles()[2]);                       // JLPT trials
    expect(start().textContent).toContain('ENTER THE TRIAL');
    expect(tiles()[2].getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(window, { key: '2' });           // Quiet practice
    expect(start().textContent).toContain('START PRACTICE');
    expect(tiles()[1].getAttribute('aria-checked')).toBe('true');
  });

  it('deploys the selected path with Enter', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: '2' });
    fireEvent.keyDown(window, { key: 'Enter' });
    // Guests are sent through sign-in first, keeping the chosen path in ?next.
    expect(window.location.pathname + window.location.search).toBe('/login?next=%2Fquiz%3Fsetup%3Dcasual');
  });

  it('deploys straight into the round when signed in', () => {
    fake.uid = 'learner';
    render(<App />);
    fireEvent.keyDown(window, { key: '1' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(window.location.pathname + window.location.search).toBe('/quiz?setup=ranked');
  });

  it('draws a random card and re-draws it on every tap', () => {
    const { container } = render(<App />);
    const face = container.querySelector('.moba-word__body') as HTMLElement;
    const read = () => container.querySelector('.moba-word__kanji')?.textContent ?? '';
    expect(face).toBeTruthy();                       // the panel always opens with a card
    expect(read().length).toBeGreaterThan(0);
    const seen = new Set<string>([read()]);
    for (let i = 0; i < 6; i += 1) { fireEvent.click(face); seen.add(read()); }
    expect(seen.size).toBeGreaterThan(1);            // "random cards, if user clicked, it changes"
    expect(container.querySelector('.moba-word__reading')?.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it('puts card library, exam and daily missions one click away', () => {
    fake.uid = 'learner'; // signed in, so the quick entries link straight through
    const { container } = render(<App />);
    const hrefs = [...container.querySelectorAll('.moba-launch a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/review');   // card library
    expect(hrefs).toContain('/exam');     // exam
    expect(hrefs).toContain('/bonus');    // daily missions
    expect(container.querySelector('.moba-quests')).toBeTruthy();
    expect(container.querySelector('.moba-vital')?.textContent).toMatch(/^Lv\.\d+$/);
    expect(container.querySelector('.winter-profile .profile-avatar')).toBeTruthy(); // the account block
    expect(container.querySelector('.profile-name strong')?.textContent).toBe('learner'); // nickname falls back to the account name
    expect(container.querySelector('.profile-name small')?.textContent).toBe('Your adventure continues');
  });

  it('collapses the mission panel without losing the reward copy', () => {
    const { container } = render(<App />);
    const quests = container.querySelector('.moba-quests') as HTMLElement;
    const head = quests.querySelector('.moba-quests__head') as HTMLElement;
    expect(quests.querySelector('.moba-quest')).toBeTruthy();
    fireEvent.click(head);
    expect(quests.querySelector('.moba-quest')).toBeNull();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head);
    expect(quests.querySelector('.moba-quest')).toBeTruthy();
  });
});
