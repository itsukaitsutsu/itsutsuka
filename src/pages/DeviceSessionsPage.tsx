import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, MonitorSmartphone, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Link } from 'wouter';
import { api, explainApiError, type DeviceSession } from '@/lib/api';

const formatTime = (value: number) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function DeviceSessionsPage() {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try { setDevices((await api.deviceSessions()).devices); }
    catch (err) { setError(explainApiError(err)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const revoke = async (device: DeviceSession) => {
    if (device.current || busyId) return;
    if (!window.confirm(`Sign out ${device.label}? It will be signed out the next time it connects.`)) return;
    setBusyId(device.id); setError(''); setNotice('');
    try {
      await api.revokeDevice(device.id);
      setNotice(`${device.label} has been signed out.`);
      await refresh();
    } catch (err) { setError(explainApiError(err)); }
    finally { setBusyId(null); }
  };

  return <section className="mx-auto max-w-3xl px-5 py-8 pb-24 md:px-10 md:py-12">
    <Link href="/cabinet" className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"><ArrowLeft size={16} /> Back to cabinet</Link>
    <div className="mt-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="mono-label text-muted-foreground">Account security</p>
        <h1 className="mt-2 font-serif text-4xl tracking-tight">Your devices</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Review browsers signed in to your account. Signing out a device blocks its app access; if it is online, it will be signed out within about a minute.</p>
      </div>
      <button type="button" onClick={() => { setLoading(true); void refresh(); }} aria-label="Refresh devices" className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-semibold hover:bg-muted"><RefreshCw size={15} /> Refresh</button>
    </div>

    {error && <div role="alert" className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
    {notice && <div role="status" className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm text-emerald-700">{notice}</div>}

    <div className="mt-7 space-y-3">
      {loading ? <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" /> Loading devices…</div>
        : devices.length === 0 ? <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">No signed-in devices were found.</div>
        : devices.map(device => <article key={device.id} className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-foreground"><MonitorSmartphone size={20} /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{device.label}</h2>
                {device.current && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700">This device</span>}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Last active {formatTime(device.lastSeenAt)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Signed in {formatTime(device.createdAt)}</p>
            </div>
          </div>
          {device.current
            ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700"><ShieldCheck size={15} /> Current session</span>
            : <button type="button" onClick={() => void revoke(device)} disabled={!!busyId} className="inline-flex h-9 items-center gap-2 rounded-lg border border-destructive/30 px-3 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50">
                {busyId === device.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Sign out
              </button>}
        </article>)}
    </div>
    <p className="mt-5 text-xs leading-5 text-muted-foreground">Device labels are inferred from the browser’s user-agent. No location tracking is used. A signed-out browser may remain open briefly, but its next API request or ranked action will be rejected.</p>
  </section>;
}
