import { useLocation } from 'wouter';
import { useAuth } from '@/auth/useAuth';
import { RankedBattle } from '@/components/RankedBattle';

function matchIdFromLocation(location: string) {
  return decodeURIComponent(location.split('/').filter(Boolean).pop() || '');
}

export function RankedRoomPage() {
  const [location, setLocation] = useLocation();
  const { user } = useAuth();
  return <RankedBattle matchId={matchIdFromLocation(location)} playerId={user?.uid ?? ''} onExit={() => setLocation('/quiz')} />;
}
