import { describe, expect, it } from 'vitest';
import { Pauses } from '../ui/src/components/speech-pauses.js';

const RATE = 16000;
const FRAME = 1024;

/** `ms` of frames: a quiet room (a little hiss), or speech (a loud tone). */
function frames(ms: number, kind: 'quiet' | 'speech'): Float32Array[] {
  const out: Float32Array[] = [];
  for (let n = Math.round((ms / 1000) * RATE); n > 0; n -= FRAME) {
    const f = new Float32Array(Math.min(FRAME, n));
    for (let i = 0; i < f.length; i++) f[i] = kind === 'speech' ? 0.2 * Math.sin(i / 3) : 0.001 * Math.sin(i * 7);
    out.push(f);
  }
  return out;
}

function feed(p: Pauses, ...parts: Float32Array[][]) {
  const pieces: Float32Array[] = [];
  for (const part of parts) for (const f of part) {
    const piece = p.push(f);
    if (piece) pieces.push(piece);
  }
  return pieces;
}

describe('cutting a recording at pauses', () => {
  it('makes a piece of each stretch of speech once the speaker is quiet for a second', () => {
    const p = new Pauses({ rate: RATE });
    // Short gaps between words do not cut; a second of quiet does.
    const pieces = feed(p, frames(2000, 'quiet'), frames(1500, 'speech'), frames(400, 'quiet'), frames(800, 'speech'), frames(1200, 'quiet'));
    expect(pieces).toHaveLength(1);
    const seconds = pieces[0]!.length / RATE;
    // The speech and the gap (2.7 s), with a little quiet kept before and after it, not the 2 s of quiet at the start.
    expect(seconds).toBeGreaterThan(2.7);
    expect(seconds).toBeLessThan(3.5);

    expect(feed(p, frames(1000, 'speech'), frames(1100, 'quiet'))).toHaveLength(1);
    expect(p.flush()).toBeUndefined();
  });

  it('drops clicks, gives the rest when the recording stops, and cuts long speech without a pause', () => {
    const p = new Pauses({ rate: RATE });
    expect(feed(p, frames(64, 'speech'), frames(1500, 'quiet'))).toHaveLength(0);
    expect(p.flush()).toBeUndefined();

    feed(p, frames(900, 'speech'), frames(200, 'quiet'));
    const rest = p.flush();
    expect(rest!.length / RATE).toBeGreaterThan(0.9);
    expect(p.flush()).toBeUndefined();

    const long = feed(p, frames(30_000, 'speech'));
    expect(long).toHaveLength(1);
    expect(long[0]!.length / RATE).toBeCloseTo(25, 0);
  });
});
