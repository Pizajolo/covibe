// Cuts a live recording into pieces at the speaker's pauses, so each piece can
// be turned into text while they go on talking. It listens to loudness: a frame
// well above the room's background noise is speech, and once speech is followed
// by about a second of quiet, everything since the last cut is one piece.

export interface PauseOptions {
  /** Samples per second of the frames it is fed. */
  rate: number;
  /** Quiet after speech that ends a piece. */
  pauseMs?: number;
  /** Less speech than this is a click or a cough: dropped. */
  minSpeechMs?: number;
  /** A piece is cut here even without a pause (whisper reads 30 s at a time). */
  maxMs?: number;
  /** Quiet kept before and after the speech, so the first and last sounds are not clipped. */
  padMs?: number;
}

export class Pauses {
  private readonly pause: number;
  private readonly minSpeech: number;
  private readonly max: number;
  private readonly pad: number;
  private frames: Float32Array[] = [];
  private length = 0;
  private speech = 0;
  private quiet = 0;
  /** The room's background loudness (RMS), learnt from the quiet frames. */
  private noise = 0.002;

  constructor(opts: PauseOptions) {
    const n = (ms: number) => Math.round((ms / 1000) * opts.rate);
    this.pause = n(opts.pauseMs ?? 1000);
    this.minSpeech = n(opts.minSpeechMs ?? 200);
    this.max = n(opts.maxMs ?? 25_000);
    this.pad = n(opts.padMs ?? 300);
  }

  /** Add a frame of samples; returns a finished piece when the speaker paused (or talked too long without one). */
  push(frame: Float32Array): Float32Array<ArrayBuffer> | undefined {
    let sum = 0;
    for (const v of frame) sum += v * v;
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const speaking = rms > Math.max(0.006, this.noise * 3);
    if (!speaking) this.noise += (rms - this.noise) * 0.05;

    this.frames.push(frame);
    this.length += frame.length;
    if (speaking) {
      this.speech += frame.length;
      this.quiet = 0;
    } else {
      this.quiet += frame.length;
    }

    if (this.speech === 0) {
      this.keepLast(this.pad);
      return undefined;
    }
    if (this.quiet >= this.pause) {
      if (this.speech < this.minSpeech) {
        this.reset();
        return undefined;
      }
      return this.cut(this.length - this.quiet + this.pad);
    }
    if (this.length >= this.max) return this.cut(this.length);
    return undefined;
  }

  /** What is left when the recording stops: a last piece, or undefined when nothing more was said. */
  flush(): Float32Array<ArrayBuffer> | undefined {
    if (this.speech < this.minSpeech) {
      this.reset();
      return undefined;
    }
    return this.cut(Math.min(this.length, this.length - this.quiet + this.pad));
  }

  /** The first `upTo` samples as one piece; the rest is dropped (it is quiet). */
  private cut(upTo: number): Float32Array<ArrayBuffer> {
    const out = new Float32Array(Math.min(upTo, this.length));
    let at = 0;
    for (const f of this.frames) {
      if (at >= out.length) break;
      out.set(f.subarray(0, out.length - at), at);
      at += f.length;
    }
    this.reset();
    return out;
  }

  private reset() {
    this.frames = [];
    this.length = 0;
    this.speech = 0;
    this.quiet = 0;
  }

  /** Before anyone speaks, keep only the last bit of quiet. */
  private keepLast(samples: number) {
    while (this.frames.length > 1 && this.length - this.frames[0]!.length >= samples) this.length -= this.frames.shift()!.length;
  }
}
