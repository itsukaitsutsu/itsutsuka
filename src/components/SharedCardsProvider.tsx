import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/auth/useAuth';
import { useLocation } from 'wouter';
import { api, ApiError, type SharedDeck } from '@/lib/api';
import type { Word } from '@/lib/vocabulary';

export type SharedCard = { deckId: string; deckName: string; word: Word };
type SharedLibrary = { decks: SharedDeck[]; cards: SharedCard[]; loading: boolean; error: string };
const empty: SharedLibrary = { decks: [], cards: [], loading: false, error: '' };
const Context = createContext<SharedLibrary>(empty);

/** Read the server's authorized, live publications. Never store a shared card in user_data or a personal save slot. */
export function SharedCardsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [location] = useLocation();
  const needed = location === '/cabinet' || location === '/review' || location === '/quiz';
  const owner = user?.uid ?? null;
  const [state, setState] = useState<Pick<SharedLibrary, 'decks' | 'loading' | 'error'> & { owner: string | null }>({ ...empty, owner: null });
  useEffect(() => {
    let active = true;
    let sequence = 0;
    setState({ owner, decks: [], loading: !!user && needed, error: '' });
    if (!user || !needed) return () => { active = false; };
    const refresh = async () => {
      const request = ++sequence;
      try {
        const summaries = [];
        let page = 0, more = true;
        while (more) {
          const result = await api.sharedDecks(page++);
          summaries.push(...result.decks);
          more = result.hasMore;
          if (page > 1000) throw new Error('Too many shared decks to load.');
        }
        // A deck may be revoked between the listing and detail requests.
        // Treat a missing detail as revoked; never retain an old copy.
        const decks: SharedDeck[] = [];
        for (let i = 0; i < summaries.length; i += 10) {
          const settled = await Promise.allSettled(summaries.slice(i, i + 10).map(deck => api.sharedDeck(deck.id)));
          for (const result of settled) {
            if (result.status === 'fulfilled') decks.push(result.value);
            else if (!(result.reason instanceof ApiError && result.reason.status === 404)) throw result.reason;
          }
        }
        if (active && request === sequence) setState({ owner, decks, loading: false, error: '' });
      } catch (err) {
        if (active && request === sequence) setState({ owner, decks: [], loading: false, error: err instanceof Error ? err.message : 'Shared cards are unavailable.' });
      }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 20_000);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [owner, needed]);
  // Never display the previous account's selected-audience cards during an auth switch.
  const library = useMemo<SharedLibrary>(() => {
    const visible = state.owner === owner && needed ? state : { decks: [], loading: !!owner && needed, error: '' };
    return { ...visible, cards: visible.decks.flatMap(deck => deck.cards.map(word => ({ deckId: deck.id, deckName: deck.name, word }))) };
  }, [state, owner, needed]);
  return <Context.Provider value={library}>{children}</Context.Provider>;
}

export const useSharedCards = () => useContext(Context);
