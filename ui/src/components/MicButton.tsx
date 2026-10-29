import { useEffect, useRef, useState } from 'react';
import { del, get, post, postRaw } from '../api';
import { go } from '../data';
import { IconMic, IconSpinner, IconStop } from './icons';
import { Pauses } from './speech-pauses';
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

/** A recording in progress: the microphone, the audio graph that listens to it, and the pieces on their way to text. */
interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: ScriptProcessorNode;
  pauses: Pauses;
  /** The voice session (whisper.cpp keeps its model loaded for it); undefined if it could not open. */
  session: Promise<string | undefined>;
  /** Pieces are turned into text one after another, so the text arrives in the order it was said. */
  queue: Promise<void>;
  heard: boolean;
  failed: boolean;
  cancelled: boolean;
  timer: number;
}

/**
 * Talk instead of typing: click to record and the text appears in the box as
 * you go: each time you pause for a second, what you said since the last pause
 * is turned into text. Click again to stop (Escape stops and throws away what
 * is not in the box yet). covibe transcribes with the engine chosen in
 * Settings → Voice input (whisper.cpp on this Mac, OpenAI or ElevenLabs); with
 * whisper.cpp the model is loaded at the first click and stays loaded until
 * the recording ends.
 */
export function MicButton({ onText, disabled, className = '' }: { onText: (text: string) => void; disabled?: boolean; className?: string }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<Recording | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

  /** Turn a piece into text after the ones before it. */
  const send = (r: Recording, piece: Float32Array<ArrayBuffer>, rate: number) => {
    r.queue = r.queue.then(async () => {
      if (r.cancelled) return;
      try {
        const id = await r.session;
        const { text } = await postRaw<{ text: string }>(`/api/voice/transcribe${id ? `?session=${id}` : ''}`, await toWav16k(piece, rate));
        if (!text || r.cancelled) return;
        r.heard = true;
        textRef.current(text);
      } catch (err) {
        if (!r.failed) toast((err as Error).message, true);
        r.failed = true;
      }
    });
  };

  /** Stop listening; unless cancelled, the rest is turned into text. Then the session ends (whisper.cpp unloads its model). */
  const finish = (r: Recording, cancel: boolean) => {
    if (rec.current !== r) return;
    rec.current = null;
    window.clearInterval(r.timer);
    r.node.onaudioprocess = null;
    r.source.disconnect();
    r.node.disconnect();
    void r.ctx.close();
    r.stream.getTracks().forEach((t) => t.stop());
    r.cancelled = cancel;
    if (!cancel) {
      const rest = r.pauses.flush();
      if (rest) send(r, rest, r.ctx.sampleRate);
    }
    setState(cancel ? 'idle' : 'transcribing');
    void r.queue.then(async () => {
      const id = await r.session;
      if (id) await del(`/api/voice/sessions/${id}`).catch(() => undefined);
      if (cancel) return;
      if (!r.heard && !r.failed) toast('Nothing was heard', true);
      setState('idle');
    });
  };

  useEffect(() => () => void (rec.current && finish(rec.current, true)), []);
  useEffect(() => {
    if (state !== 'recording') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !rec.current) return;
      e.preventDefault();
      finish(rec.current, true);
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
    // whisper.cpp starts loading its model now, while the microphone opens and you start talking.
    const session = post<{ id: string }>('/api/voice/sessions').then(
      (s) => s.id,
      () => undefined,
    );
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      void session.then((id) => id && del(`/api/voice/sessions/${id}`).catch(() => undefined));
      toast(
        (err as Error).name === 'NotAllowedError'
          ? 'covibe may not use the microphone: allow it in System Settings → Privacy & Security → Microphone'
          : `Could not open the microphone: ${(err as Error).message}`,
        true,
      );
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const r: Recording = { stream, ctx, source, node, pauses: new Pauses({ rate: ctx.sampleRate }), session, queue: Promise.resolve(), heard: false, failed: false, cancelled: false, timer: 0 };
    rec.current = r;
    node.onaudioprocess = (e) => {
      const piece = r.pauses.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if (piece) send(r, piece, ctx.sampleRate);
    };
    source.connect(node);
    node.connect(ctx.destination); // it only runs when connected; its output is silence
    void ctx.resume();
    setSeconds(0);
    const began = Date.now();
    r.timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 500);
    setState('recording');
  };

  const click = () => {
    if (state === 'recording') {
      if (rec.current) finish(rec.current, false);
    } else if (state === 'idle') void start();
  };
  const label = state === 'recording' ? 'Stop (Esc stops and throws away what is not in the box yet)' : state === 'transcribing' ? 'Turning the rest into text…' : 'Talk instead of typing';
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

/** Mix a piece down to 16 kHz (what whisper wants) and write it as 16-bit mono WAV. */
async function toWav16k(samples: Float32Array<ArrayBuffer>, from: number): Promise<Blob> {
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((samples.length / from) * rate)), rate);
  const buffer = offline.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
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
