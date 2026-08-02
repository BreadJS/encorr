import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Columns2,
  Expand,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { api, formatBytes } from '@/utils/api';

const PANEL = 'rounded-2xl border border-[#39363a] bg-[#282729]';

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '00:00';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    : `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function mediaErrorMessage(video: HTMLVideoElement | null, label: string): string {
  if (video?.error?.code === 4) {
    return `${label} uses a container or codec this browser cannot decode.`;
  }
  if (video?.error?.code === 2) return `${label} could not be streamed from the server.`;
  if (video?.error?.code === 3) return `${label} could not be decoded by this browser.`;
  return `${label} could not be loaded.`;
}

export function FileCompare() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const originalRef = useRef<HTMLVideoElement>(null);
  const transcodedRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const animationRef = useRef<number | null>(null);
  const [split, setSplit] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [audioSource, setAudioSource] = useState<'original' | 'transcoded'>('original');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [mediaError, setMediaError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['file-comparison', id],
    queryFn: () => api.getComparisonInfo(id),
    enabled: Boolean(id),
    retry: false,
  });

  const originalUrl = id ? api.getComparisonStreamUrl(id, 'original') : '';
  const transcodedUrl = id ? api.getComparisonStreamUrl(id, 'transcoded') : '';

  const applyAudio = () => {
    const original = originalRef.current;
    const transcoded = transcodedRef.current;
    if (!original || !transcoded) return;
    original.volume = volume;
    transcoded.volume = volume;
    original.muted = muted || audioSource !== 'original';
    transcoded.muted = muted || audioSource !== 'transcoded';
  };

  useEffect(applyAudio, [audioSource, muted, volume]);

  useEffect(() => {
    const original = originalRef.current;
    const transcoded = transcodedRef.current;
    if (original) original.playbackRate = playbackRate;
    if (transcoded) transcoded.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (!playing) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }
    const tick = () => {
      const original = originalRef.current;
      const transcoded = transcodedRef.current;
      if (!original || !transcoded) return;
      const drift = transcoded.currentTime - original.currentTime;
      if (Math.abs(drift) > 0.08 && !original.seeking && !transcoded.seeking) {
        transcoded.currentTime = original.currentTime;
      }
      setCurrentTime(original.currentTime);
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [playing]);

  const updateDuration = () => {
    const values = [originalRef.current?.duration, transcodedRef.current?.duration]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
    if (values.length > 0) setDuration(Math.min(...values));
  };

  const togglePlayback = async () => {
    const original = originalRef.current;
    const transcoded = transcodedRef.current;
    if (!original || !transcoded) return;
    if (!original.paused || !transcoded.paused) {
      original.pause();
      transcoded.pause();
      setPlaying(false);
      return;
    }

    setMediaError(null);
    transcoded.currentTime = original.currentTime;
    applyAudio();
    const results = await Promise.allSettled([original.play(), transcoded.play()]);
    if (results.some(result => result.status === 'rejected')) {
      original.pause();
      transcoded.pause();
      setPlaying(false);
      setMediaError('One of the videos could not start. Its codec may not be supported by this browser.');
      return;
    }
    setPlaying(true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.code === 'Space') {
        event.preventDefault();
        void togglePlayback();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const seekTo = (value: number) => {
    const normalized = Math.max(0, Math.min(duration || value, value));
    if (originalRef.current) originalRef.current.currentTime = normalized;
    if (transcodedRef.current) transcodedRef.current.currentTime = normalized;
    setCurrentTime(normalized);
  };

  const updateSplitFromPointer = (clientX: number) => {
    const bounds = viewerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setSplit(Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100)));
  };

  if (query.isLoading) {
    return <div className="grid min-h-[70vh] place-items-center"><div className="flex items-center gap-3 text-sm text-gray-400"><RefreshCw className="h-5 w-5 animate-spin text-[#74c69d]" />Preparing comparison…</div></div>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <button onClick={() => navigate('/files')} className="mb-5 flex items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Back to files</button>
        <div className={`${PANEL} p-8 text-center`}>
          <AlertTriangle className="mx-auto h-8 w-8 text-amber-400" />
          <h1 className="mt-4 text-xl font-semibold text-white">Comparison unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-gray-400">{query.error instanceof Error ? query.error.message : 'The original or transcoded output could not be found.'}</p>
        </div>
      </div>
    );
  }

  const { original, transcoded } = query.data;
  const saved = Math.max(0, original.size - transcoded.size);

  return (
    <div className="mx-auto max-w-[1700px] space-y-5 pb-10">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <button onClick={() => navigate('/files')} className="mb-3 flex items-center gap-2 text-xs font-medium text-gray-500 hover:text-white"><ArrowLeft className="h-3.5 w-3.5" />Back to files</button>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#74c69d]"><Columns2 className="h-3.5 w-3.5" />Quality comparison</div>
          <h1 className="mt-2 truncate text-2xl font-semibold text-white sm:text-3xl" title={query.data.filename}>{query.data.filename}</h1>
          <p className="mt-1.5 text-sm text-gray-400">Drag the divider to reveal the original on the left and transcoded output on the right.</p>
          {query.data.source_kind === 'retained_backup' && (
            <p className="mt-2 text-xs text-amber-300/80">Comparing the retained original backup with the transcoded file currently installed in your library.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg border border-[#39363a] bg-[#282729] px-3 py-2 text-gray-400">Saved <strong className="ml-1 text-[#95d5b2]">{formatBytes(saved)}</strong></span>
          <span className="rounded-lg border border-[#39363a] bg-[#282729] px-3 py-2 text-gray-400">Output <strong className="ml-1 text-white">{Math.round((transcoded.size / Math.max(1, original.size)) * 100)}%</strong></span>
        </div>
      </header>

      <section className={`${PANEL} overflow-hidden`}>
        <div
          ref={viewerRef}
          className="relative aspect-video max-h-[76vh] w-full touch-none select-none overflow-hidden bg-black"
          onPointerMove={event => { if (draggingRef.current) updateSplitFromPointer(event.clientX); }}
          onPointerUp={() => { draggingRef.current = false; }}
          onPointerCancel={() => { draggingRef.current = false; }}
        >
          <video
            ref={transcodedRef}
            src={transcodedUrl}
            preload="metadata"
            playsInline
            className="absolute inset-0 h-full w-full bg-black object-contain"
            onLoadedMetadata={updateDuration}
            onEnded={() => { originalRef.current?.pause(); setPlaying(false); }}
            onError={() => setMediaError(mediaErrorMessage(transcodedRef.current, 'Transcoded output'))}
          />
          <div className="pointer-events-none absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
            <video
              ref={originalRef}
              src={originalUrl}
              preload="metadata"
              playsInline
              className="absolute inset-0 h-full w-full bg-black object-contain"
              onLoadedMetadata={updateDuration}
              onEnded={() => { transcodedRef.current?.pause(); setPlaying(false); }}
              onError={() => setMediaError(mediaErrorMessage(originalRef.current, 'Original'))}
            />
          </div>

          <div className="pointer-events-none absolute left-4 top-4 rounded-lg bg-black/65 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur">Original</div>
          <div className="pointer-events-none absolute right-4 top-4 rounded-lg bg-black/65 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white backdrop-blur">Transcoded</div>

          <button
            type="button"
            role="slider"
            aria-label="Comparison divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split)}
            className="absolute inset-y-0 z-10 w-10 -translate-x-1/2 cursor-ew-resize focus:outline-none"
            style={{ left: `${split}%` }}
            onPointerDown={event => {
              draggingRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              updateSplitFromPointer(event.clientX);
            }}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') setSplit(value => Math.max(0, value - (event.shiftKey ? 10 : 1)));
              if (event.key === 'ArrowRight') setSplit(value => Math.min(100, value + (event.shiftKey ? 10 : 1)));
            }}
          >
            <span className="absolute bottom-0 left-1/2 top-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_12px_rgba(0,0,0,0.9)]" />
            <span className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-[#1e1d1f]/90 text-xs font-bold text-white shadow-xl">↔</span>
          </button>

          {!playing && !mediaError && (
            <button onClick={() => void togglePlayback()} className="absolute left-1/2 top-1/2 z-20 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/25 bg-black/60 text-white backdrop-blur hover:bg-black/75" aria-label="Play comparison"><Play className="ml-1 h-7 w-7" /></button>
          )}
          {mediaError && (
            <div className="absolute inset-x-6 bottom-6 z-20 mx-auto flex max-w-2xl items-start gap-3 rounded-xl border border-red-500/40 bg-red-950/90 p-4 text-sm text-red-100 shadow-2xl backdrop-blur">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" /><div><p className="font-medium">Playback problem</p><p className="mt-1 text-red-200/75">{mediaError}</p></div>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-[#39363a] bg-[#222123] px-4 py-4 sm:px-5">
          <div className="flex items-center gap-3">
            <span className="w-12 text-right font-mono text-[11px] text-gray-400">{formatTime(currentTime)}</span>
            <input type="range" min={0} max={Math.max(duration, 0.01)} step={0.01} value={Math.min(currentTime, duration || currentTime)} onChange={event => seekTo(Number(event.target.value))} className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[#74c69d]" aria-label="Comparison timeline" />
            <span className="w-12 font-mono text-[11px] text-gray-400">{formatTime(duration)}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => void togglePlayback()} className="grid h-9 w-9 place-items-center rounded-lg bg-[#74c69d] text-[#14251d] hover:bg-[#95d5b2]" aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}</button>
            <button onClick={() => seekTo(Math.max(0, currentTime - 5))} className="grid h-9 w-9 place-items-center rounded-lg border border-[#39363a] text-gray-300 hover:bg-white/5" aria-label="Back five seconds"><RotateCcw className="h-4 w-4" /></button>
            <button onClick={() => setMuted(value => !value)} className="grid h-9 w-9 place-items-center rounded-lg border border-[#39363a] text-gray-300 hover:bg-white/5" aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
            <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} className="h-1.5 w-24 accent-[#74c69d]" aria-label="Volume" />
            <div className="mx-1 h-5 w-px bg-[#39363a]" />
            <label className="flex items-center gap-2 text-xs text-gray-500">Audio
              <select value={audioSource} onChange={event => setAudioSource(event.target.value as 'original' | 'transcoded')} className="rounded-lg border border-[#39363a] bg-[#282729] px-2 py-1.5 text-xs text-gray-200 focus:outline-none"><option value="original">Original</option><option value="transcoded">Transcoded</option></select>
            </label>
            <label className="ml-auto flex items-center gap-2 text-xs text-gray-500">Speed
              <select value={playbackRate} onChange={event => setPlaybackRate(Number(event.target.value))} className="rounded-lg border border-[#39363a] bg-[#282729] px-2 py-1.5 text-xs text-gray-200 focus:outline-none"><option value={0.5}>0.5×</option><option value={0.75}>0.75×</option><option value={1}>1×</option><option value={1.25}>1.25×</option><option value={1.5}>1.5×</option><option value={2}>2×</option></select>
            </label>
            <button onClick={() => viewerRef.current?.requestFullscreen()} className="grid h-9 w-9 place-items-center rounded-lg border border-[#39363a] text-gray-300 hover:bg-white/5" aria-label="Fullscreen"><Expand className="h-4 w-4" /></button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        {([
          { label: 'Original', data: original, accent: '#60a5fa' },
          { label: 'Transcoded', data: transcoded, accent: '#74c69d' },
        ] as const).map(item => (
          <div key={item.label} className={`${PANEL} p-5`}>
            <div className="flex items-center justify-between"><h2 className="font-semibold text-white">{item.label}</h2><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.accent }} /></div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Codec</p><p className="mt-1 text-sm font-medium text-gray-300">{item.data.codec?.toUpperCase() || 'Unknown'}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Container</p><p className="mt-1 text-sm font-medium text-gray-300">{item.data.container.toUpperCase()}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Resolution</p><p className="mt-1 text-sm font-medium text-gray-300">{item.data.width && item.data.height ? `${item.data.width}×${item.data.height}` : 'Source'}</p></div>
              <div><p className="text-[10px] uppercase tracking-wider text-gray-600">Size</p><p className="mt-1 text-sm font-medium text-gray-300">{formatBytes(item.data.size)}</p></div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
