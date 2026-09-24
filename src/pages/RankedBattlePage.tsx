import { useLocation } from 'wouter';
import { useAuth } from '@/auth/useAuth';
import { RankedBattle } from '@/components/RankedBattle';

export function RankedBattlePage() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  return <RankedBattle matchId={decodeURIComponent(location.split('/').filter(Boolean).pop() || '')} playerId={user?.uid ?? ''} onExit={() => setLocation('/quiz')} />;
}
