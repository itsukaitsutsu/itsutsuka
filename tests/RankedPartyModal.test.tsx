import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RankedPartyModal } from '@/components/RankedPartyModal';
afterEach(cleanup);
describe('party review-time controls', () => {
  it('defaults to three seconds and offers an explicit zero-delay preset', () => {
    const create = vi.fn(); render(<RankedPartyModal onClose={vi.fn()} onCreate={create} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create lobby' })); expect(create.mock.calls[0][0].reviewMs).toBe(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Off (0s)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create lobby' })); expect(create.mock.calls[1][0].reviewMs).toBe(0);
  });
  it('converts custom seconds to milliseconds and retains wager selections', () => {
    const create = vi.fn(); render(<RankedPartyModal onClose={vi.fn()} onCreate={create} />);
    fireEvent.click(screen.getByRole('button', { name: /Mastered cards \+ points/ }));
    fireEvent.change(screen.getByLabelText('Custom review time (seconds)'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create lobby' }));
    expect(create).toHaveBeenCalledWith({ wagerType: 'cards_points', wagerPoints: 10, wagerCards: 5, reviewMs: 2500 });
  });
  it.each(['', '-1', '10.5', '0.25'])('blocks invalid review input %j', value => {
    const create = vi.fn(); render(<RankedPartyModal onClose={vi.fn()} onCreate={create} />);
    fireEvent.change(screen.getByLabelText('Custom review time (seconds)'), { target: { value } });
    expect((screen.getByRole('button', { name: 'Create lobby' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Create lobby' })); expect(create).not.toHaveBeenCalled();
  });
  it('does not let the guest set review time when joining', () => {
    const join = vi.fn(); render(<RankedPartyModal onClose={vi.fn()} onJoin={join} />);
    fireEvent.click(screen.getByRole('button', { name: 'Join room' }));
    expect(screen.queryByLabelText('Custom review time (seconds)')).toBeNull();
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join lobby' })); expect(join).toHaveBeenCalledWith('ABC123');
  });
});
