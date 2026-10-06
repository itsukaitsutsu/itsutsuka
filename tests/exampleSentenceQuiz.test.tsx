import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import { resetExampleCache } from '@/lib/exampleSentences';

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

const files: Record<string, string> = {
  '/examples/manufacture.json': readFileSync('public/examples/manufacture.json', 'utf8'),
  '/examples/agriculture.json': readFileSync('public/examples/agriculture.json', 'utf8'),
};
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (files[url]) return new Response(files[url], { status: 200, headers: { 'content-type': 'application/json' } });
  throw new Error(`unexpected network call: ${url}`);
});

const card = (id: string, expression: string, reading: string, meaning: string) =>
  ({ id, expression, reading, meaning, level: 'Custom', tags: [], partOfSpeechEn: 'Noun', partOfSpeechJp: '名詞' });
function deck(name: string, cards: ReturnType<typeof card>[]) {
  fake.sharedDecks = [{ id: 'published-1', name, cardCount: cards.length, visibility: 'selected', updatedAt: 'today', cards }];
}
const quizUrl = (direction = 'meaning') => `/quiz?run=1&sharedDeck=published-1&count=1&direction=${direction}&timerMode=session&sessionSeconds=600`;
async function openQuiz(direction?: string) {
  await act(async () => window.history.pushState({}, '', quizUrl(direction)));
  render(<App />);
  await screen.findByTestId('quiz-card');
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  localStorage.clear(); sessionStorage.clear();
  resetFake(); fake.uid = 'learner';
  resetExampleCache(); fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('example sentence box on SSW quiz cards', () => {
  it('shows an exact-match example from the PDFs, highlighted, with its source', async () => {
    deck('SSW_Manufacture_1', [card('c1', '整理', 'せいり', 'sorting out')]);
    await openQuiz();
    const toggle = await screen.findByTestId('example-sentence-toggle');
    expect(screen.queryByTestId('example-sentence')).toBeNull();          // collapsed until clicked
    fireEvent.click(toggle);
    const text = (await screen.findByTestId('example-sentence-text')).textContent ?? '';
    expect(text).toContain('整理');
    expect(screen.getByTestId('example-sentence-text').querySelector('mark.example-hit')?.textContent).toBe('整理');
    expect(screen.getByTestId('example-sentence-source').textContent).toMatch(/p\.\d+/);
  });

  it('uses only one static file and never touches the API/D1', async () => {
    deck('SSW_Manufacture_1', [card('c1', '整理', 'せいり', 'sorting out')]);
    await openQuiz();
    await screen.findByTestId('example-sentence-toggle');
    fireEvent.click(screen.getByTestId('example-sentence-toggle'));
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual(['/examples/manufacture.json']);
  });

  it('shows nothing when the word has no exact example', async () => {
    deck('SSW_Manufacture_1', [card('c1', '猫', 'ねこ', 'cat')]);
    await openQuiz();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
  });

  it('does not match a different form of a verb (食べる vs 食べた)', async () => {
    deck('SSW_Manufacture_1', [card('c1', '食べる', 'たべる', 'to eat')]);
    await openQuiz();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
  });

  it('is off for decks that are not named SSW — and loads nothing', async () => {
    deck('Kitchen words', [card('c1', '整理', 'せいり', 'sorting out')]);
    await openQuiz();
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is off for an SSW sector with no PDFs — and loads nothing', async () => {
    deck('SSW_Care_1', [card('c1', '整理', 'せいり', 'sorting out')]);
    await openQuiz();
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is off for built-in JLPT decks — and loads nothing', async () => {
    await act(async () => window.history.pushState({}, '', '/quiz?run=1&decks=N5&count=1&direction=meaning&timerMode=session&sessionSeconds=600'));
    render(<App />);
    await screen.findByTestId('quiz-card');
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('in "Choose Japanese" the example stays hidden until the card is answered (it would reveal the word)', async () => {
    deck('SSW_Manufacture_1', [card('c1', '整理', 'せいり', 'sorting out')]);
    await openQuiz('word');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await settle();
    expect(screen.queryByTestId('example-sentence-box')).toBeNull();
    fireEvent.click(screen.getByTestId('quiz-answer-1'));
    expect(await screen.findByTestId('example-sentence-toggle')).toBeTruthy();
  });
});
