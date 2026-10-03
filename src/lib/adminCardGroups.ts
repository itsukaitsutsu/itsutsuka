export type AdminCardGroup = {
  id: string;
  name: string;
  wordIds: string[];
  createdAt: string;
};

export function sanitizeAdminCardGroups(raw: unknown): AdminCardGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .filter(item => typeof item.id === 'string' && item.id.trim() !== '' && typeof item.name === 'string')
    .map(item => ({
      id: item.id as string,
      name: (item.name as string).trim().slice(0, 120) || 'Untitled group',
      wordIds: Array.isArray(item.wordIds) ? [...new Set(item.wordIds.filter((id): id is string => typeof id === 'string'))].slice(0, 5000) : [],
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
    }));
}
