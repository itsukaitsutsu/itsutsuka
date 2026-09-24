// Cabinet paging — pure helpers for "how many word cards the shelf shows at
// once". The chosen size is remembered per signed-in account in localStorage;
// keeping the math here means it can be unit-tested without React.
export const CABINET_PAGE_SIZES = [4, 8, 12, 24, 48] as const;
export const CABINET_PAGE_SIZE_DEFAULT: number = 4;

export function cabinetPageSizeKey(uid?: string) {
  return uid ? `kotoba:${uid}:cabinet-size` : 'kotoba:cabinet-size';
}
export function loadCabinetPageSize(uid?: string): number {
  try {
    const raw = Number(localStorage.getItem(cabinetPageSizeKey(uid)));
    return (CABINET_PAGE_SIZES as readonly number[]).includes(raw) ? raw : CABINET_PAGE_SIZE_DEFAULT;
  } catch { return CABINET_PAGE_SIZE_DEFAULT; }
}
export function saveCabinetPageSize(uid: string | undefined, size: number) {
  try {
    if ((CABINET_PAGE_SIZES as readonly number[]).includes(size)) localStorage.setItem(cabinetPageSizeKey(uid), String(size));
  } catch { /* storage unavailable (private mode etc.) — the choice just won't persist */ }
}
export function totalPagesFor(count: number, pageSize: number) {
  const size = pageSize > 0 ? Math.floor(pageSize) : CABINET_PAGE_SIZE_DEFAULT;
  return Math.max(1, Math.ceil(Math.max(0, Math.floor(count)) / size));
}
export function clampPage(page: number, pages: number) {
  const p = Number.isFinite(page) ? Math.floor(page) : 0;
  return Math.min(Math.max(0, p), Math.max(0, pages) - 1);
}

// ── Random shelf option ───────────────────────────────────────────────────────
// "Random" ON = the filtered words are shuffled (stable within a page, so
// pagination never repeats or skips a card). ON is the default; only an
// explicit "0" turns it off for that account.
export function cabinetShuffleKey(uid?: string) {
  return uid ? `kotoba:${uid}:cabinet-shuffle` : 'kotoba:cabinet-shuffle';
}
export function loadCabinetShuffle(uid?: string): boolean {
  try { return localStorage.getItem(cabinetShuffleKey(uid)) !== '0'; } catch { return true; }
}
export function saveCabinetShuffle(uid: string | undefined, on: boolean) {
  try { localStorage.setItem(cabinetShuffleKey(uid), on ? '1' : '0'); } catch { /* storage unavailable — just won't persist */ }
}
