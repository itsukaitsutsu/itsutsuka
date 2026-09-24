import { useEffect, useMemo, useRef, useState } from 'react';
import { Flag, Headphones, Mic, Pause, Play, RotateCcw, Star, Trophy, Upload, Volume2, VolumeX, X, Zap, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/auth/useAuth';
import {
  SOUND_SETTINGS_CHANGED,
  makeSoundAsset,
  loadSoundSettings,
  playSoundAsset,
  saveSoundSettings,
  supportsSoundFile,
  type SoundAsset,
  type SoundMode,
  type SoundSettings as StoredSoundSettings,
  type SoundSlot,
} from '@/lib/soundSettings';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const MAX_SOUND_BYTES = 12 * 1024 * 1024;

type SoundSettingsProps = {
  mode: SoundMode;
};

type SlotDefinition = {
  slot: SoundSlot;
  label: string;
  icon: LucideIcon;
};

type SlotGroups = {
  answer: SlotDefinition[];
  finish: SlotDefinition[];
};

function slotDefinitions(mode: SoundMode): SlotGroups {
  if (mode === 'quiz') {
    return {
      answer: [
        { slot: 'quizCombo1', label: 'Combo 1', icon: Zap },
        { slot: 'quizCombo2', label: 'Combo 2', icon: Zap },
        { slot: 'quizCombo3', label: 'Combo 3', icon: Zap },
        { slot: 'quizCombo4', label: 'Combo 4', icon: Zap },
        { slot: 'quizCombo5', label: 'Combo 5', icon: Zap },
        { slot: 'quizIncorrect', label: 'Incorrect', icon: X },
      ],
      finish: [
        { slot: 'quizFinishPerfect', label: 'Finish · Perfect (100%)', icon: Trophy },
        { slot: 'quizFinishHigh', label: 'Finish · High (≥80%)', icon: Star },
        { slot: 'quizFinishLow', label: 'Finish · Low (<80%)', icon: Flag },
      ],
    };
  }
  return {
    answer: [{ slot: 'jlptAnswer', label: 'Answer', icon: Headphones }],
    finish: [
      { slot: 'jlptFinishPerfect', label: 'Finish · Perfect (100%)', icon: Trophy },
      { slot: 'jlptFinishHigh', label: 'Finish · High (≥80%)', icon: Star },
      { slot: 'jlptFinishLow', label: 'Finish · Low (<80%)', icon: Flag },
    ],
  };
}

function bytesLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useSoundSettings(owner: string) {
  const [settings, setSettings] = useState<StoredSoundSettings>({ enabled: true, finishEnabled: true, assets: {} });

  useEffect(() => {
    let alive = true;
    void loadSoundSettings(owner).then((next) => { if (alive) setSettings(next); });
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ owner?: string }>).detail;
      if (!detail?.owner || detail.owner === owner) void loadSoundSettings(owner).then((next) => { if (alive) setSettings(next); });
    };
    window.addEventListener(SOUND_SETTINGS_CHANGED, onChange);
    return () => { alive = false; window.removeEventListener(SOUND_SETTINGS_CHANGED, onChange); };
  }, [owner]);

  const update = async (next: StoredSoundSettings) => {
    setSettings(next);
    await saveSoundSettings(owner, next);
  };

  return { settings, update };
}

export function SoundSettings({ mode }: SoundSettingsProps) {
  const { user } = useAuth();
  const owner = user?.uid ?? 'anonymous';
  const { settings, update } = useSoundSettings(owner);
  const [open, setOpen] = useState(false);
  const [recordingSlot, setRecordingSlot] = useState<SoundSlot | null>(null);
  const [previewingSlot, setPreviewingSlot] = useState<SoundSlot | null>(null);
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const previewRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRefs = useRef<Partial<Record<SoundSlot, HTMLInputElement | null>>>({});
  const slotGroups = useMemo(() => slotDefinitions(mode), [mode]);
  const finishOn = settings.finishEnabled !== false;
  const stopPreview = () => {
    previewRef.current?.pause();
    previewRef.current = null;
    setPreviewingSlot(null);
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(() => () => {
    stopRecording();
    stopPreview();
  }, []);

  const replaceAsset = async (slot: SoundSlot, asset: SoundAsset | undefined) => {
    const assets = { ...settings.assets };
    if (asset) assets[slot] = asset;
    else delete assets[slot];
    await update({ ...settings, assets });
  };

  const handleFile = async (slot: SoundSlot, file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!supportsSoundFile(file)) {
      setError('MP3 or WAV only');
      return;
    }
    if (file.size > MAX_SOUND_BYTES) {
      setError('File is too large');
      return;
    }
    await replaceAsset(slot, makeSoundAsset(file, file.name));
  };

  const startRecording = async (slot: SoundSlot) => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Recording unavailable');
      return;
    }
    try {
      stopPreview();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
      const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      setRecordingSlot(slot);
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => { setError('Recording failed'); setRecordingSlot(null); stopRecording(); };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size <= MAX_SOUND_BYTES) void replaceAsset(slot, makeSoundAsset(blob, 'voice recording'));
        else setError('Recording is too large');
        chunksRef.current = [];
        setRecordingSlot(null);
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
      };
      recorder.start();
    } catch {
      setRecordingSlot(null);
      setError('Microphone permission needed');
    }
  };

  const toggleRecording = (slot: SoundSlot) => {
    if (recordingSlot === slot) {
      stopRecording();
      return;
    }
    if (recordingSlot) {
      stopRecording();
      window.setTimeout(() => { void startRecording(slot); }, 0);
      return;
    }
    void startRecording(slot);
  };

  const togglePreview = (slot: SoundSlot) => {
    const asset = settings.assets[slot];
    if (!asset) return;
    if (previewingSlot === slot) {
      stopPreview();
      return;
    }
    stopPreview();
    const audio = playSoundAsset(asset);
    if (!audio) return;
    previewRef.current = audio;
    setPreviewingSlot(slot);
    audio.addEventListener('ended', () => setPreviewingSlot(null), { once: true });
  };

  const toggleEnabled = () => { void update({ ...settings, enabled: !settings.enabled }); };
  const toggleFinish = () => { void update({ ...settings, finishEnabled: !finishOn }); };

  const renderSlot = ({ slot, label, icon: SlotIcon }: SlotDefinition, dimmed: boolean) => {
    const asset = settings.assets[slot];
    const isRecording = recordingSlot === slot;
    return <div key={slot} className={cn('rounded-xl border border-border p-3', dimmed && 'opacity-55')} data-testid={`sound-slot-${slot}`}>
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><SlotIcon size={15} /></span>
        <span className="min-w-0 flex-1 truncate text-sm font-bold">{label}</span>
        {asset && <button type="button" onClick={() => togglePreview(slot)} aria-label={previewingSlot === slot ? `Pause ${label} sound` : `Play ${label} sound`} title={previewingSlot === slot ? 'Pause' : 'Preview'} className="grid size-8 place-items-center rounded-lg text-[hsl(var(--secondary))] hover:bg-[hsl(var(--secondary)/.1)]" data-testid={`preview-sound-${slot}`}>{previewingSlot === slot ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}</button>}
        <button type="button" onClick={() => fileInputRefs.current[slot]?.click()} aria-label={`Upload ${label} sound`} title="Upload MP3 or WAV" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted" data-testid={`upload-sound-${slot}`}><Upload size={15} /></button>
        <button type="button" onClick={() => toggleRecording(slot)} aria-pressed={isRecording} aria-label={isRecording ? `Stop recording ${label} sound` : `Record ${label} sound`} title={isRecording ? 'Stop recording' : 'Record'} className={cn('grid size-8 place-items-center rounded-lg', isRecording ? 'bg-[hsl(var(--accent)/.16)] text-[hsl(var(--accent))]' : 'text-muted-foreground hover:bg-muted')} data-testid={`record-sound-${slot}`}>{isRecording ? <RotateCcw size={15} className="animate-spin" /> : <Mic size={15} />}</button>
        {asset && <button type="button" onClick={() => { stopPreview(); void replaceAsset(slot, undefined); }} aria-label={`Remove ${label} sound`} title="Remove" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-muted" data-testid={`remove-sound-${slot}`}><X size={15} /></button>}
      </div>
      <div className="mt-2 flex items-center gap-2 pl-11 text-[11px] text-muted-foreground">
        <span className="truncate">{asset?.name ?? 'Default'}</span>
        {asset && <span className="shrink-0 opacity-60">{bytesLabel(asset.blob.size)}</span>}
      </div>
      <input ref={(element) => { fileInputRefs.current[slot] = element; }} type="file" accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav" className="hidden" onChange={(event) => { void handleFile(slot, event.target.files?.[0]); event.target.value = ''; }} />
    </div>;
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!next) { stopRecording(); stopPreview(); } setOpen(next); }}>
    <DialogTrigger asChild>
      <button
        type="button"
        aria-label={settings.enabled ? 'Sound settings' : 'Sounds off'}
        title={settings.enabled ? 'Sound settings' : 'Sounds off'}
        className={cn(
          'grid size-9 place-items-center rounded-full border transition-colors',
          settings.enabled ? 'border-[hsl(var(--secondary)/.45)] text-[hsl(var(--secondary))] hover:bg-[hsl(var(--secondary)/.1)]' : 'border-border text-muted-foreground hover:bg-muted',
        )}
        data-testid={`sound-settings-${mode}`}
      >
        {settings.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>
    </DialogTrigger>
    <DialogContent className="max-w-md rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between pr-7">
        <DialogTitle className="font-serif text-2xl">Sounds</DialogTitle>
        <button type="button" onClick={toggleEnabled} aria-pressed={settings.enabled} aria-label={settings.enabled ? 'Turn sounds off' : 'Turn sounds on'} title={settings.enabled ? 'Turn sounds off' : 'Turn sounds on'} className={cn('grid size-9 place-items-center rounded-full border', settings.enabled ? 'border-[hsl(var(--secondary)/.45)] text-[hsl(var(--secondary))]' : 'border-border text-muted-foreground')} data-testid={`toggle-sounds-${mode}`}>
          {settings.enabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
      </div>
      <div className="mt-4 max-h-[62vh] space-y-2 overflow-y-auto pr-1">
        <p className="mono-label px-1 pt-1 text-muted-foreground">Answer sounds</p>
        {slotGroups.answer.map((definition) => renderSlot(definition, false))}
        <div className="flex items-center justify-between px-1 pt-3" data-testid={`finish-sounds-section-${mode}`}>
          <p className="mono-label text-muted-foreground">Finish sounds</p>
          <button type="button" onClick={toggleFinish} aria-pressed={finishOn} aria-label={finishOn ? 'Turn finish sounds off' : 'Turn finish sounds on'} title={finishOn ? 'Turn finish sounds off' : 'Turn finish sounds on'} className={cn('grid size-9 place-items-center rounded-full border', finishOn ? 'border-[hsl(var(--secondary)/.45)] text-[hsl(var(--secondary))]' : 'border-border text-muted-foreground')} data-testid={`toggle-finish-sounds-${mode}`}>
            {finishOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
        </div>
        {!finishOn && <p className="px-1 text-[11px] text-muted-foreground">Finish sounds are muted — answer sounds still play.</p>}
        {slotGroups.finish.map((definition) => renderSlot(definition, !finishOn))}
      </div>
      {error && <p role="status" className="mt-3 text-xs font-semibold text-[hsl(var(--accent))]">{error}</p>}
    </DialogContent>
  </Dialog>;
}

/**
 * One-tap master mute for live test headers. No dialog opens, so it can be
 * flipped mid-round without interrupting the test — it silences both answer
 * and finish sounds instantly.
 */
export function SoundMuteButton({ mode }: SoundSettingsProps) {
  const { user } = useAuth();
  return <SoundMuteToggle mode={mode} owner={user?.uid ?? 'anonymous'} />;
}

/** Same on/off switch, but for screens that already know the player id (ranked rooms). */
export function SoundMuteToggle({ mode, owner }: { mode: SoundMode | 'ranked'; owner: string }) {
  const { settings, update } = useSoundSettings(owner);
  const [busy, setBusy] = useState(false);
  const on = settings.enabled !== false;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Reload first so a quick tap can't clobber settings still loading
      // from IndexedDB with the in-memory defaults.
      const current = await loadSoundSettings(owner);
      await update({ ...current, enabled: !current.enabled });
    } finally {
      setBusy(false);
    }
  };

  return <button
    type="button"
    onClick={() => void toggle()}
    disabled={busy}
    aria-pressed={on}
    aria-label={on ? 'Mute all sounds' : 'Unmute all sounds'}
    title={on ? 'Mute all sounds' : 'Unmute all sounds'}
    className={cn(
      'grid size-9 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-50',
      on ? 'border-[hsl(var(--secondary)/.45)] text-[hsl(var(--secondary))] hover:bg-[hsl(var(--secondary)/.1)]' : 'border-border text-muted-foreground hover:bg-muted',
    )}
    data-testid={`mute-sounds-${mode}`}
  >
    {on ? <Volume2 size={16} /> : <VolumeX size={16} />}
  </button>;
}
