import { resultBandForScore } from '@/lib/vocabulary';

export type SoundMode = 'quiz' | 'jlpt';
export type SoundSlot =
  | 'quizCombo1'
  | 'quizCombo2'
  | 'quizCombo3'
  | 'quizCombo4'
  | 'quizCombo5'
  | 'quizIncorrect'
  | 'quizFinishPerfect'
  | 'quizFinishHigh'
  | 'quizFinishLow'
  | 'quizFinish' // Legacy single finish slot — migrates into the three quiz finish slots.
  | 'quizCorrect' // Legacy slot kept so existing user sounds can migrate to Combo 1.
  | 'jlptAnswer'
  | 'jlptFinishPerfect'
  | 'jlptFinishHigh'
  | 'jlptFinishLow';

export type SoundAsset = {
  name: string;
  type: string;
  blob: Blob;
};

export type SpeechVoicePreference = {
  uri: string;
  name: string;
  lang: string;
};

export type SoundSettings = {
  enabled: boolean;
  /** Independent on/off for the end-of-test finish sounds (perfect / high / low). */
  finishEnabled: boolean;
  assets: Partial<Record<SoundSlot, SoundAsset>>;
  speechVoice?: SpeechVoicePreference;
};

type StoredSoundSettings = SoundSettings & {
  key: string;
};

const DB_NAME = 'kotoba-personal-sounds';
const DB_VERSION = 1;
const STORE_NAME = 'settings';
export const SOUND_SETTINGS_CHANGED = 'kotoba-sound-settings-changed';

const defaults = (): SoundSettings => ({ enabled: true, finishEnabled: true, assets: {} });

const KNOWN_SLOTS = [
  'quizCombo1', 'quizCombo2', 'quizCombo3', 'quizCombo4', 'quizCombo5',
  'quizIncorrect',
  'quizFinishPerfect', 'quizFinishHigh', 'quizFinishLow',
  'quizFinish', 'quizCorrect',
  'jlptAnswer', 'jlptFinishPerfect', 'jlptFinishHigh', 'jlptFinishLow',
] as const;
const cache = new Map<string, SoundSettings>();
let databasePromise: Promise<IDBDatabase> | null = null;

function storageKey(owner: string) {
  return owner || 'anonymous';
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open sound storage.'));
  });
  return databasePromise;
}

function validAsset(value: unknown): value is SoundAsset {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SoundAsset>;
  return typeof item.name === 'string' && typeof item.type === 'string' && item.blob instanceof Blob;
}

function cleanSettings(value: unknown): SoundSettings {
  if (!value || typeof value !== 'object') return defaults();
  const item = value as Partial<StoredSoundSettings>;
  const assets: Partial<Record<SoundSlot, SoundAsset>> = {};
  for (const slot of KNOWN_SLOTS) {
    if (validAsset(item.assets?.[slot])) assets[slot] = item.assets[slot];
  }
  if (!assets.quizCombo1 && assets.quizCorrect) assets.quizCombo1 = assets.quizCorrect;
  delete assets.quizCorrect;
  // The old single finish sound becomes the sound for all three score bands,
  // unless the user already customized a band.
  if (assets.quizFinish) {
    if (!assets.quizFinishPerfect) assets.quizFinishPerfect = assets.quizFinish;
    if (!assets.quizFinishHigh) assets.quizFinishHigh = assets.quizFinish;
    if (!assets.quizFinishLow) assets.quizFinishLow = assets.quizFinish;
  }
  delete assets.quizFinish;
  const speechVoice = item.speechVoice && typeof item.speechVoice.uri === 'string' && typeof item.speechVoice.name === 'string' && typeof item.speechVoice.lang === 'string'
    ? item.speechVoice
    : undefined;
  return {
    enabled: item.enabled !== false,
    finishEnabled: item.finishEnabled !== false,
    assets,
    ...(speechVoice ? { speechVoice } : {}),
  };
}

export async function loadSoundSettings(owner: string): Promise<SoundSettings> {
  const key = storageKey(owner);
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const database = await openDatabase();
    const value = await new Promise<unknown>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not read sound settings.'));
    });
    const settings = cleanSettings(value);
    cache.set(key, settings);
    return settings;
  } catch {
    const settings = defaults();
    cache.set(key, settings);
    return settings;
  }
}

export async function saveSoundSettings(owner: string, settings: SoundSettings): Promise<void> {
  const key = storageKey(owner);
  const clean = cleanSettings(settings);
  cache.set(key, clean);
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put({ key, ...clean } satisfies StoredSoundSettings);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Could not save sound settings.'));
    });
  } catch {
    // Sound customization is intentionally local-only. If the browser blocks
    // IndexedDB, the current session still keeps the setting in memory.
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SOUND_SETTINGS_CHANGED, { detail: { owner: key } }));
}

export function speechVoiceKey(voice: SpeechSynthesisVoice) {
  return voice.voiceURI || `${voice.name}|${voice.lang}`;
}

export function getJapaneseSpeechVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices()
    .filter((voice) => voice.lang.toLowerCase().startsWith('ja'))
    .sort((a, b) => Number(/google/i.test(b.name)) - Number(/google/i.test(a.name)) || a.name.localeCompare(b.name));
}

export function getPreferredSpeechVoice(settings: SoundSettings) {
  const voices = getJapaneseSpeechVoices();
  const preferred = settings.speechVoice
    ? voices.find((voice) => speechVoiceKey(voice) === settings.speechVoice?.uri || (voice.name === settings.speechVoice?.name && voice.lang === settings.speechVoice?.lang))
    : undefined;
  return preferred
    ?? voices.find((voice) => /google/i.test(voice.name))
    ?? voices[0]
    ?? null;
}

export function getCachedSoundSettings(owner: string): SoundSettings | undefined {
  return cache.get(storageKey(owner));
}

export function clearCachedSoundSettings(owner: string) {
  cache.delete(storageKey(owner));
}

export async function playUserSound(
  owner: string,
  slot: SoundSlot,
  fallback?: () => void,
  onAudio?: (audio: HTMLAudioElement) => void,
) {
  const cached = getCachedSoundSettings(owner) ?? await loadSoundSettings(owner);
  if (!cached.enabled) return;
  const asset = cached.assets[slot];
  if (!asset) {
    fallback?.();
    return;
  }
  const url = URL.createObjectURL(asset.blob);
  try {
    const audio = new Audio(url);
    audio.volume = 0.7;
    onAudio?.(audio);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    audio.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    await audio.play();
  } catch {
    URL.revokeObjectURL(url);
    // A browser can reject custom audio in an embedded preview. Do not replace
    // a user's sound with the default after an explicit custom sound fails.
  }
}

/**
 * Pick the finish slot for a completed test.
 * 100% (score === total) -> Perfect, >= 80% -> High, anything below -> Low.
 */
export function finishSlotForScore(mode: SoundMode, score: number, total: number): SoundSlot {
  const band = resultBandForScore(score, total);
  if (mode === 'jlpt') return band === 'perfect' ? 'jlptFinishPerfect' : band === 'high' ? 'jlptFinishHigh' : 'jlptFinishLow';
  return band === 'perfect' ? 'quizFinishPerfect' : band === 'high' ? 'quizFinishHigh' : 'quizFinishLow';
}

/**
 * Play the end-of-test finish sound for a score. Honors both the master
 * Sounds switch and the separate Finish switch; falls back to the default
 * perfect / high / low sound when the user set no custom sound for the band.
 */
export async function playUserFinishSound(
  owner: string,
  mode: SoundMode,
  score: number,
  total: number,
  fallback?: () => void,
  onAudio?: (audio: HTMLAudioElement) => void,
) {
  const cached = getCachedSoundSettings(owner) ?? await loadSoundSettings(owner);
  if (!cached.enabled || !cached.finishEnabled) return;
  await playUserSound(owner, finishSlotForScore(mode, score, total), fallback, onAudio);
}

export function playSoundAsset(asset: SoundAsset): HTMLAudioElement | null {
  try {
    const url = URL.createObjectURL(asset.blob);
    const audio = new Audio(url);
    audio.volume = 0.7;
    const cleanup = () => URL.revokeObjectURL(url);
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });
    void audio.play().catch(cleanup);
    return audio;
  } catch {
    return null;
  }
}

export function supportsSoundFile(file: File) {
  return /^(audio\/(mpeg|mp3|wav|x-wav|wave)|audio\/webm|audio\/ogg)$/.test(file.type) || /\.(mp3|wav|webm|ogg)$/i.test(file.name);
}

export function makeSoundAsset(blob: Blob, name: string): SoundAsset {
  return { blob, name, type: blob.type || 'audio/wav' };
}
