import { useEffect, useState } from 'react';
import { Headphones } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import { useSoundSettings } from '@/components/SoundSettings';
import { getJapaneseSpeechVoices, speechVoiceKey } from '@/lib/soundSettings';
import { cn } from '@/lib/utils';

export function useSimulationSpeechSettings() {
  const { user } = useAuth();
  const { settings } = useSoundSettings(user?.uid ?? 'anonymous');
  return settings;
}

export function SimulationSpeechVoice() {
  const { user } = useAuth();
  const owner = user?.uid ?? 'anonymous';
  const { settings, update } = useSoundSettings(owner);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const refresh = () => setVoices(getJapaneseSpeechVoices());
    refresh();
    window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, []);

  const selected = settings.speechVoice?.uri ?? '';
  const choose = (value: string) => {
    const voice = voices.find((item) => speechVoiceKey(item) === value);
    void update({
      ...settings,
      speechVoice: voice ? { uri: speechVoiceKey(voice), name: voice.name, lang: voice.lang } : undefined,
    });
  };

  return <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-border bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="simulation-speech-voice">
    <div className="flex items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[hsl(var(--secondary)/.12)] text-[hsl(var(--secondary))]"><Headphones size={17} /></span>
      <div>
        <p className="text-sm font-bold">Listening voice</p>
        <p className="text-xs text-muted-foreground">Japanese speech for 聴解 practice</p>
      </div>
    </div>
    <select value={selected} onChange={(event) => choose(event.target.value)} disabled={voices.length === 0} className={cn('h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-xs font-semibold outline-none focus:ring-2 focus:ring-[hsl(var(--secondary)/.35)] sm:max-w-[260px]', voices.length === 0 && 'cursor-not-allowed opacity-60')} aria-label="Listening voice" data-testid="select-simulation-speech-voice">
      <option value="">Auto · Google Japanese when available</option>
      {voices.map((voice) => <option key={speechVoiceKey(voice)} value={speechVoiceKey(voice)}>{voice.name} · {voice.lang}</option>)}
    </select>
  </div>;
}
