import { feedbackAudio, playFeedback } from '@/lib/vocabulary';

const STORAGE_KEY = 'kotoba-audio-settings';
const MAX_UPLOAD_BYTES = 1_500_000;

export type AudioSettings = {
  answerSoundEnabled: boolean;
  finishSoundEnabled: boolean;
  /** Empty string = browser default Japanese voice */
  voiceURI: string;
  customAnswerDataUrl: string | null;
  customFinishHighDataUrl: string | null;
  customFinishLowDataUrl: string | null;
  customFinishPerfectDataUrl: string | null;
};

export const defaultAudioSettings: AudioSettings = {
  answerSoundEnabled: true,
  finishSoundEnabled: true,
  voiceURI: '',
  customAnswerDataUrl: null,
  customFinishHighDataUrl: null,
  customFinishLowDataUrl: null,
  customFinishPerfectDataUrl: null,
};

export function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultAudioSettings };
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      ...defaultAudioSettings,
      ...parsed,
      answerSoundEnabled: parsed.answerSoundEnabled !== false,
      finishSoundEnabled: parsed.finishSoundEnabled !== false,
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
      customAnswerDataUrl: parsed.customAnswerDataUrl || null,
      customFinishHighDataUrl: parsed.customFinishHighDataUrl || null,
      customFinishLowDataUrl: parsed.customFinishLowDataUrl || null,
      customFinishPerfectDataUrl: parsed.customFinishPerfectDataUrl || null,
    };
  } catch {
    return { ...defaultAudioSettings };
  }
}

export function saveAudioSettings(patch: Partial<AudioSettings>): AudioSettings {
  const next = { ...loadAudioSettings(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Quota / private mode — keep in-memory next for this session only. */
  }
  return next;
}

export function isAudioFile(file: File) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return type.includes('audio') || name.endsWith('.mp3') || name.endsWith('.wav');
}

export async function fileToDataUrl(file: File): Promise<string> {
  if (!isAudioFile(file)) throw new Error('Please choose an .mp3 or .wav file.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('File is too large (max about 1.5 MB).');
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

export function listSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}

export function japaneseVoices(voices: SpeechSynthesisVoice[]) {
  const ja = voices.filter((v) => v.lang.toLowerCase().startsWith('ja'));
  return ja.length > 0 ? ja : voices;
}

export function speakJapanese(
  text: string,
  voiceURI: string,
  handlers: { onend?: () => void; onerror?: () => void } = {},
) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ja-JP';
  const voices = listSpeechVoices();
  const match = voiceURI ? voices.find((v) => v.voiceURI === voiceURI) : undefined;
  if (match) utterance.voice = match;
  utterance.onend = () => handlers.onend?.();
  utterance.onerror = () => handlers.onerror?.();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function playAnswerSound(settings = loadAudioSettings()) {
  if (!settings.answerSoundEnabled) return;
  playFeedback(settings.customAnswerDataUrl || feedbackAudio.answer);
}

export function playFinishSound(highScore: boolean, settings = loadAudioSettings(), isPerfect = false) {
  if (!settings.finishSoundEnabled) return;
  if (isPerfect) {
    playFeedback(settings.customFinishPerfectDataUrl || feedbackAudio.perfect);
    return;
  }
  const custom = highScore ? settings.customFinishHighDataUrl : settings.customFinishLowDataUrl;
  playFeedback(custom || (highScore ? feedbackAudio.high : feedbackAudio.low));
}
