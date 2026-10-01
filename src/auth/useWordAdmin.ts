import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

export function useWordAdmin() {
  const { user } = useAuth();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let active = true;
    setAllowed(false);
    if (user) void api.wordAdminStatus().then(({ isAdmin }) => { if (active) setAllowed(isAdmin); }).catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [user?.uid]);
  return allowed;
}
