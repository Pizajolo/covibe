import { useEffect, useRef, useState } from 'react';
import { get, postRaw } from '../api';
import { go } from '../data';
import { IconMic, IconSpinner, IconStop } from './icons';
import { useToast } from './ui';

/** What Settings → Voice input says about the chosen engine. */
interface VoiceReady {
  ready: boolean;
  problem?: string;
}

/** Add spoken text to what is already typed, with a space between. */
export function withSpoken(typed: string, spoken: string): string {
  if (!spoken) return typed;
  if (!typed.trim()) return spoken;
  return /\s$/.test(typed) ? typed + spoken : `${typed} ${spoken}`;
}

/**
 * Talk instead of typing: click to record, click again (or press Escape to
 * throw it away) and the text appears in the box. The recording becomes
 * 16 kHz mono WAV here and covibe transcribes it with the engine chosen in
 * Settings → Voice input (whisper.cpp on this Mac, OpenAI or ElevenLabs).
 */
export function MicButton({ onText, disabled, className = '' }: { onText: (text: string) => void; disabled?: boolean; className?: string }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean; timer: number } | null>(null);

  const stopTracks = () => {
    const r = rec.current;
    if (!r) return;
    window.clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
  };
  useEffect(() => () => {
    if (rec.current) rec.current.cancelled = true;
    if (rec.current?.recorder.state === 'recording') rec.current.recorder.stop();
    stopTracks();
  }, []);
  useEffect(() => {
    if (state !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !rec.current) return;
      e.preventDefault();
      rec.current.cancelled = true;
      rec.current.recorder.stop();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state]);

  const start = async () => {
    const voice = await get<VoiceReady>('/api/voice').catch(() => undefined);
    if (voice && !voice.ready) {
      toast(`Voice input is not ready: ${voice.problem}`, true);
      go('settings');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      toast(
        (err as Error).name === 'NotAllowedError'
          ? 'covibe may not use the microphone: allow it in System Settings → Privacy & Security → Microphone'
          : `Could not open the microphone: ${(err as Error).message}`,
        true,
      );
      return;
    }
    const recorder = new MediaRecorder(stream);
    const r = { recorder, stream, chunks: [] as Blob[], cancelled: false, timer: 0 };
    rec.current = r;
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    recorder.onstop = () => {
      stopTracks();
      rec.current = null;
      if (r.cancelled) return setState('idle');
      setState('transcribing');
      void (async () => {
        try {
          const wav = await toWav16k(new Blob(r.chunks, { type: recorder.mimeType }));
          const { text } = await postRaw<{ text: string }>('/api/voice/transcribe', wav);
          if (text) onText(text);
          else toast('Nothing was heard', true);
        } catch (err) {
          toast((err as Error).message, true);
        } finally {
          setState('idle');
        }
      })();
    };
    recorder.start(250);
    setSeconds(0);
    const began = Date.now();
    r.timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 500);
    setState('recording');
  };

  const click = () => {
    if (state === 'recording') rec.current?.recorder.stop();
    else if (state === 'idle') void start();
  };
  const label = state === 'recording' ? 'Stop and turn into text (Esc throws it away)' : state === 'transcribing' ? 'Turning it into text…' : 'Talk instead of typing';
  return (
    <button
      type="button"
      className={`btn icon-btn mic-btn ${state} ${className}`}
      disabled={disabled || state === 'transcribing'}
      onClick={click}
      title={label}
      aria-label={label}
      aria-pressed={state === 'recording'}
    >
      {state === 'recording' ? <IconStop /> : state === 'transcribing' ? <IconSpinner /> : <IconMic />}
      {state === 'recording' && <span className="tiny mono">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>}
    </button>
  );
}

/** Decode a recording, mix it down to mono at 16 kHz (what whisper wants), and write it as 16-bit WAV. */
async function toWav16k(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close();
  }
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}
