import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { readFileSync } from 'node:fs';
const appCss = readFileSync(`${import.meta.dirname}/../src/index.css`, 'utf8');

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

// Drive the inertia loop deterministically rather than waiting for real time.
function inertiaClock() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { pending.set(++id, callback); return id; });
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(key => { pending.delete(key); });
  const advance = (frames = 1, milliseconds = 1000 / 60) => act(() => {
    for (let i = 0; i < frames; i++) {
      now += milliseconds;
      const callbacks = [...pending.values()]; pending.clear();
      callbacks.forEach(callback => callback(now));
    }
  });
  return { advance, pending, cancel };
}

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
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('shows the real app navigation, mode selector, mission status and vocabulary card', async () => {
    render(<App />);
    expect(await screen.findByTestId('archive-lobby')).toBeTruthy();
    expect(screen.getByTestId('archive-rail-review').getAttribute('href')).toBe('/review');
    expect(screen.queryByTestId('archive-rail-cabinet')).toBeNull();
    expect(screen.getByTestId('home-mode-ranked').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('archive-mission-link').getAttribute('href')).toBe('/bonus');
    const missionWrap = screen.getByTestId('archive-mission-wrap');
    expect(missionWrap.parentElement?.classList.contains('archive-lobby__header')).toBe(true);
    expect(missionWrap.previousElementSibling?.classList.contains('archive-lobby__brand-group')).toBe(true);
    expect(missionWrap.previousElementSibling?.querySelector('[data-testid="link-logo"]')).toBeTruthy();
    expect(missionWrap.querySelector('[data-testid="link-logo"]')).toBeNull();
    expect(screen.queryByTestId('archive-word-card')).toBeNull();
    const eggTrigger = screen.getByTestId('archive-easter-egg-trigger');
    expect(eggTrigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(eggTrigger);
    const hiddenWordCard = await screen.findByTestId('archive-word-card');
    expect(hiddenWordCard.textContent).toContain('HIDDEN CARD');
    expect(hiddenWordCard.textContent).toMatch(/[\\p{Script=Han}\\p{Script=Hiragana}]/u);
    expect(eggTrigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('archive-action-results').getAttribute('href')).toBe('/results');
    expect(screen.getByTestId('archive-action-jlpt-simulation').getAttribute('href')).toBe('/jlpt-simulation');
    expect(screen.getByTestId('archive-action-jlpt-simulation').textContent).toContain('JLPT simulation');
    expect(screen.queryByTestId('archive-action-progress')).toBeNull();
  });

  it('keeps the desktop navigation full-width and anchored to the bottom', () => {
    const desktopSheet = appCss.match(/@media\s*\(min-width:\s*768px\)\s*\{\s*\.archive-mobile-sheet\s*\{([^}]+)\}/)?.[1];
    expect(desktopSheet).toBeDefined();
    const rules = desktopSheet!.replace(/\s+/g, ' ');
    for (const rule of ['top: auto;', 'right: 0;', 'bottom: 0;', 'left: 0;', 'width: 100%;', 'max-height: 92dvh;', 'border-bottom: 0;', 'border-radius: 22px 22px 0 0;']) {
      expect(rules).toContain(rule);
    }
  });

  it('keeps the deleted Cabinet/More dock controls and menu bonus card removed', async () => {
    render(<App />);
    await screen.findByTestId('archive-lobby');
    const dock = screen.getByRole('navigation', { name: 'Main navigation' });
    expect([...dock.querySelectorAll('a')].map(link => link.textContent)).toEqual(['Library', 'Exam', 'Missions']);
    expect(screen.queryByTestId('home-dock-cabinet')).toBeNull();
    expect(screen.queryByTestId('home-dock-more')).toBeNull();
    const trigger = screen.getByTestId('button-home-menu');
    expect(trigger.textContent).toBe('言');
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeTruthy();
    expect(screen.queryByTestId('mobile-link-daily-bonus')).toBeNull();
    expect(screen.getByTestId('mobile-nav-my-words').getAttribute('href')).toBe('/custom');
    expect(screen.getByTestId('mobile-nav-cabinet').getAttribute('href')).toBe('/cabinet');
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
  it('opens the shared menu from the header without a desktop-hidden wrapper and reaches My words', async () => {
    render(<App />);
    const trigger = await screen.findByTestId('button-home-menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog.className).not.toMatch(/(?:^|\s)(?:md:|lg:)?hidden(?:\s|$)/);
    expect(screen.getByRole('navigation', { name: 'App navigation' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('mobile-nav-my-words'));
    await screen.findByTestId('add-form');
    expect(window.location.pathname).toBe('/custom');
  });

  it('closes the header menu with Escape and releases the scroll lock', async () => {
    render(<App />);
    const trigger = await screen.findByTestId('button-home-menu');
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull());
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('glides after a wheel gesture without page overflow, slows down and reverses on demand', async () => {
    const clock = inertiaClock();
    vi.stubGlobal('scrollY', 0);
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(window.innerHeight);
    const view = render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    const far = () => parseFloat(scene.style.getPropertyValue('--ridge-far-x'));
    const near = () => parseFloat(scene.style.getPropertyValue('--ridge-near-x'));
    const eggOffset = () => parseFloat(lobby.style.getPropertyValue('--ridge-egg-x'));
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance();
    const firstStep = far();
    expect(firstStep).toBeGreaterThan(0); expect(near()).toBeLessThan(0);
    expect(eggOffset()).toBeCloseTo(firstStep, 2);
    clock.advance(60); // No further input: momentum must continue.
    const afterGlide = far();
    expect(afterGlide).toBeGreaterThan(firstStep);
    clock.advance();
    expect(far() - afterGlide).toBeLessThan(firstStep);
    const beforeReverse = far(); const nearBeforeReverse = near();
    fireEvent.wheel(lobby, { deltaY: -100 }); clock.advance();
    expect(far()).toBeLessThan(beforeReverse); expect(near()).toBeGreaterThan(nearBeforeReverse);
    expect(window.scrollY).toBe(0);
    view.unmount();
    expect(clock.cancel).toHaveBeenCalled();
    expect(clock.pending.size).toBe(0);
  });

  it('wraps endlessly while pushed, caps speed and eventually rests after input stops', async () => {
    const clock = inertiaClock(); render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    const near = () => parseFloat(scene.style.getPropertyValue('--ridge-near-x'));
    const eggOffset = () => parseFloat(lobby.style.getPropertyValue('--ridge-egg-x'));
    let wrapped = false; let previous = 0;
    for (let i = 0; i < 240; i++) {
      fireEvent.wheel(lobby, { deltaY: 10000 }); clock.advance();
      const next = near();
      if (next > previous) wrapped = true;
      const movement = (previous - next + 1000) % 1000;
      expect(movement).toBeGreaterThan(0);
      expect(movement).toBeLessThanOrEqual(15);
      expect(Math.abs(next)).toBeLessThan(1000);
      previous = next;
    }
    expect(wrapped).toBe(true);
    expect(eggOffset()).toBeGreaterThan(1000);
    clock.advance(1800);
    expect(clock.pending.size).toBe(0);
    const resting = near(); clock.advance(60);
    expect(near()).toBe(resting);
  });

  it.each([30, 60, 120])('has consistent glide distance at %s frames per second', async (fps) => {
    const clock = inertiaClock(); render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance(fps, 1000 / fps);
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    const rate = -Math.log(0.99) * 60;
    const expected = 120 * (1 - Math.exp(-rate)) / rate * 0.7;
    expect(parseFloat(scene.style.getPropertyValue('--ridge-far-x'))).toBeCloseTo(expected, 2);
  });

  it('keeps gliding after touch release and reverses with an opposite swipe', async () => {
    const clock = inertiaClock(); render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    const far = () => parseFloat(scene.style.getPropertyValue('--ridge-far-x'));
    fireEvent.touchStart(lobby, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(lobby, { touches: [{ clientY: 100 }] }); clock.advance();
    const first = far(); expect(first).toBeGreaterThan(0);
    fireEvent.touchEnd(lobby, { touches: [] }); clock.advance(30);
    const coast = far(); expect(coast).toBeGreaterThan(first);
    fireEvent.touchStart(lobby, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(lobby, { touches: [{ clientY: 200 }] }); clock.advance();
    expect(far()).toBeLessThan(coast);
  });

  it('does not double-count native scrolling or animate beneath an open menu', async () => {
    const clock = inertiaClock(); vi.stubGlobal('scrollY', 0);
    render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    fireEvent.wheel(lobby, { deltaY: 100 });
    vi.stubGlobal('scrollY', 100); fireEvent.scroll(window); clock.advance();
    const rate = -Math.log(0.99) * 60;
    expect(parseFloat(scene.style.getPropertyValue('--ridge-far-x'))).toBeCloseTo(120 * 0.01 / rate * 0.7, 2);
    fireEvent.click(screen.getByTestId('button-home-menu')); clock.advance();
    const stopped = scene.style.getPropertyValue('--ridge-far-x');
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance(30);
    expect(scene.style.getPropertyValue('--ridge-far-x')).toBe(stopped);
    expect(clock.pending.size).toBe(0);
  });

  it('respects zoom/reduced motion and stops when the document is hidden', async () => {
    const clock = inertiaClock();
    let onChange: (() => void) | undefined;
    const media = { matches: false, addEventListener: vi.fn((_event, listener) => { onChange = listener; }), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => media));
    const view = render(<App />);
    const lobby = await screen.findByTestId('archive-lobby');
    const scene = lobby.querySelector('.archive-lobby__scene') as HTMLElement;
    const far = () => parseFloat(scene.style.getPropertyValue('--ridge-far-x'));
    fireEvent.wheel(lobby, { deltaY: 100, ctrlKey: true }); clock.advance(); expect(far()).toBe(0);
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance(); expect(far()).toBeGreaterThan(0);
    media.matches = true; onChange?.();
    expect(far()).toBe(0); expect(clock.pending.size).toBe(0);
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance(); expect(far()).toBe(0);
    media.matches = false; onChange?.();
    fireEvent.wheel(lobby, { deltaY: 100 }); clock.advance();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(clock.pending.size).toBe(0);
    view.unmount(); expect(media.removeEventListener).toHaveBeenCalledWith('change', onChange);
  });

});
