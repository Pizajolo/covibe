# Chiptune score for the covibe brag video: 120 BPM in C, one beat grid from frame 0.
# python3 -I music.py out.wav
import sys, wave
import numpy as np

SR = 44100
DUR = 20.5
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(7)

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def idx(t): return int(round(t * SR))

def lowpass(x, cutoff, taps=127):
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff / SR * n) * np.hamming(taps)
    return np.convolve(x, h / h.sum(), mode='same')

def env(n, a, d, s, r, hold):
    """ADSR over n samples; hold = seconds before release."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = t > hold
    e[rel] *= np.exp(-(t[rel] - hold) / max(r, 1e-4))
    return e

def osc(kind, f, n, duty=0.5, vib=0.0):
    t = np.arange(n) / SR
    ph = f * t + (vib * np.sin(2 * np.pi * 5.5 * t) * np.clip(t - 0.15, 0, None) if vib else 0)
    p = ph % 1.0
    if kind == 'pulse': return np.where(p < duty, 1.0, -1.0)
    if kind == 'tri': return 4 * np.abs(p - 0.5) - 1
    if kind == 'sine': return np.sin(2 * np.pi * ph)

tracks = {k: np.zeros(N) for k in ['bass', 'arp', 'lead', 'pad', 'drums', 'sfx']}

def put(track, t, sig, gain=1.0):
    i = idx(t)
    j = min(N, i + len(sig))
    if j > i: tracks[track][i:j] += sig[: j - i] * gain

def note(track, t, m, dur, kind='pulse', gain=0.3, duty=0.5, a=0.004, d=0.12, s=0.6, r=0.08, vib=0.0, tail=0.4):
    n = int((dur + tail) * SR)
    put(track, t, osc(kind, mtof(m), n, duty, vib) * env(n, a, d, s, r, dur), gain)

# ---------------------------------------------------------------- harmony
# (start, chord tones as midi, root)
C, Am, F, G = [60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]
CHORDS = [(0, Am), (2, F), (4, G), (6, C), (8, G), (10, Am), (12, F), (13, G), (14, C), (16, G), (17, C)]
def chord_at(t):
    cur = CHORDS[0][1]
    for s, ch in CHORDS:
        if t >= s - 1e-9: cur = ch
    return cur

# pad: soft, slow attack; carries the sleepy intro and the outro
for k, (s, ch) in enumerate(CHORDS):
    e = CHORDS[k + 1][0] if k + 1 < len(CHORDS) else DUR - 0.2
    g = 0.045 if s < 6 else 0.035
    if s >= 17: g = 0.08
    for m in ch:
        note('pad', s, m, e - s, 'pulse', g, duty=0.5, a=0.25 if s < 6 else 0.05, d=0.6, s=0.8, r=0.25 if s < 17 else 1.4, vib=0.004, tail=1.6 if s >= 17 else 0.3)

# arp: 8ths while asleep, 16ths once the office wakes; rests during the gate failure beat
pattern = [0, 1, 2, 1]
step = 0
t = 0.0
while t < 17.0 - 1e-9:
    ch = chord_at(t)
    awake = t >= 6
    if not (11.0 <= t < 12.0 and int(round(t / 0.125)) % 2):
        m = ch[pattern[step % 4]] + 12
        note('arp', t, m, 0.07 if awake else 0.18, 'pulse', 0.09 if awake else 0.075, duty=0.25, d=0.06, s=0.3, r=0.05, tail=0.12)
    step += 1
    t += 0.125 if awake else 0.25

# bass: whole notes while asleep, driving 8ths from 6.0
for s, ch in CHORDS:
    if s < 6:
        note('bass', s, ch[0] - 24 if ch[0] - 24 >= 33 else ch[0] - 12, 1.9, 'tri', 0.35, a=0.02, d=0.5, s=0.7, r=0.2)
t = 6.0
while t < 17.0 - 1e-9:
    root = chord_at(t)[0] - 24
    if root < 33: root += 12
    k = int(round((t - 6) / 0.25)) % 8
    m = root + (12 if k in (3, 7) else 0)
    if not (11.0 <= t < 12.0 and k % 2):
        note('bass', t, m, 0.2, 'tri', 0.42, d=0.1, s=0.7, r=0.04, tail=0.06)
    t += 0.25
note('bass', 17.0, 36, 2.5, 'tri', 0.45, a=0.005, d=0.8, s=0.5, r=1.0, tail=1.0)

# lead melody (time, midi, dur)
LEAD = [
    (6.0, 76, .4), (6.5, 79, .4), (7.0, 84, .4), (7.5, 79, .2), (7.75, 76, .2),
    (8.0, 74, .4), (8.5, 79, .4), (9.0, 83, .4), (9.5, 81, .2), (9.75, 79, .2),
    (10.0, 84, .25), (10.25, 83, .25), (10.5, 81, .45),
    (12.0, 81, .25), (12.25, 84, .25), (12.5, 81, .45), (13.0, 83, .25), (13.25, 86, .25), (13.5, 83, .45),
    (14.0, 84, .4), (14.5, 88, .4), (15.0, 91, .4), (15.5, 88, .2), (15.75, 84, .2),
    (16.0, 86, .25), (16.25, 83, .25), (16.5, 79, .45),
    (17.0, 84, 1.8),
]
for t0, m, d in LEAD:
    note('lead', t0, m, d, 'pulse', 0.13 if t0 < 17 else 0.11, duty=0.5, d=0.15, s=0.65, r=0.08 if t0 < 17 else 0.9, vib=0.006, tail=0.3 if t0 < 17 else 1.6)

# ---------------------------------------------------------------- drums
def kick(t, g=0.75):
    n = int(0.25 * SR); tt = np.arange(n) / SR
    f = 50 + 110 * np.exp(-tt / 0.03)
    put('drums', t, np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.09), g)
def snare(t, g=0.28):
    n = int(0.18 * SR); tt = np.arange(n) / SR
    nz = lowpass(rng.standard_normal(n), 6000, 31)
    put('drums', t, (nz * 0.8 + 0.4 * np.sin(2 * np.pi * 190 * tt)) * np.exp(-tt / 0.05), g)
def hat(t, g=0.06):
    n = int(0.05 * SR); tt = np.arange(n) / SR
    nz = rng.standard_normal(n); nz = nz - lowpass(nz, 7000, 31)
    put('drums', t, nz * np.exp(-tt / 0.012), g)
def crash(t, g=0.12):
    n = int(1.8 * SR); tt = np.arange(n) / SR
    nz = rng.standard_normal(n); nz = nz - lowpass(nz, 4000, 31)
    put('drums', t, nz * np.exp(-tt / 0.45), g)

b = 6.0
while b < 17.0 - 1e-9:
    k = int(round((b - 6) / BEAT)) % 4
    gate_fail = 11.0 <= b < 12.0
    if not gate_fail:
        if k in (0, 2): kick(b)
        if k in (1, 3): snare(b)
    hat(b, 0.05); hat(b + 0.25, 0.035)
    b += BEAT
for i in range(4): snare(13.5 + i * 0.125, 0.12 + i * 0.04)   # fill into "all gates passed"
kick(4.0, 0.35); kick(5.0, 0.35); kick(5.5, 0.4); kick(5.75, 0.45)  # heartbeat before the office wakes
crash(6.0, 0.08); crash(14.0, 0.11); kick(17.0, 0.8); crash(17.0, 0.13)


# ---------------------------------------------------------------- effects, in key and on the grid
# typing: 32nd-note ticks with a tiny pitched blip from the C pentatonic
PENTA = [72, 74, 76, 79, 81]
t = 3.3125
k = 0
while t < 4.75:
    n = int(0.03 * SR); tt = np.arange(n) / SR
    nz = rng.standard_normal(n); nz = nz - lowpass(nz, 2500, 31)
    put('sfx', t, nz * np.exp(-tt / 0.006), 0.05)
    note('sfx', t, PENTA[(k * 3) % 5] + 12, 0.02, 'tri', 0.03, d=0.02, s=0.2, r=0.02, tail=0.03)
    t += 0.0625; k += 1

def click(t0):
    n = int(0.04 * SR); tt = np.arange(n) / SR
    put('sfx', t0, np.sin(2 * np.pi * 1200 * tt) * np.exp(-tt / 0.008), 0.12)
click(5.0); click(16.0)
note('sfx', 5.0, 84, 0.08, 'tri', 0.1, d=0.08, s=0.2, r=0.1)   # Start: C6
# rising sweep into the office waking
n = int(1.0 * SR); tt = np.arange(n) / SR
sw = rng.standard_normal(n)
sw = lowpass(sw, 3000, 63) * (tt / 1.0) ** 2
put('sfx', 5.0, sw, 0.06)
# gate fails: a soft descending bonk, E4 → C4
note('sfx', 11.0, 64, 0.12, 'pulse', 0.1, duty=0.5, d=0.1, s=0.5, r=0.06)
note('sfx', 11.25, 60, 0.3, 'pulse', 0.1, duty=0.5, d=0.15, s=0.5, r=0.12)
# gates pass: little dings
for t0 in (12.75, 13.5):
    note('sfx', t0, 84, 0.06, 'tri', 0.12, d=0.1, s=0.3, r=0.15)
    note('sfx', t0 + 0.0625, 88, 0.06, 'tri', 0.12, d=0.1, s=0.3, r=0.2)
for i, m in enumerate([84, 88, 91, 96]):
    note('sfx', 14.0 + i * 0.0625, m, 0.06, 'tri', 0.1, d=0.12, s=0.3, r=0.25)
# merged toast
note('sfx', 16.125, 79, 0.06, 'tri', 0.1, d=0.1, s=0.3, r=0.15)
note('sfx', 16.25, 84, 0.1, 'tri', 0.1, d=0.15, s=0.3, r=0.3)

# ---------------------------------------------------------------- mix
mix_gain = {'bass': 0.9, 'arp': 0.8, 'lead': 0.75, 'pad': 0.7, 'drums': 0.85, 'sfx': 0.8}
cut = {'bass': 2500, 'arp': 3800, 'lead': 4500, 'pad': 2200, 'drums': 12000, 'sfx': 6000}
dry = np.zeros(N)
send = np.zeros(N)
sends = {'bass': 0.0, 'arp': 0.25, 'lead': 0.3, 'pad': 0.35, 'drums': 0.08, 'sfx': 0.35}
for k, x in tracks.items():
    y = lowpass(x, cut[k]) * mix_gain[k]
    dry += y
    send += y * sends[k]

# room: exponentially decaying noise IR, FFT convolution
irn = int(1.3 * SR)
ir = rng.standard_normal(irn) * np.exp(-np.arange(irn) / SR / 0.32)
ir = lowpass(ir, 5000, 63)
ir /= np.sqrt(np.sum(ir ** 2))
L = N + irn
F = 1 << (L - 1).bit_length()
wet = np.fft.irfft(np.fft.rfft(send, F) * np.fft.rfft(ir, F), F)[:N] * 0.35

pre = 0.004  # tiny stereo spread on the wet signal
dl = int(pre * SR)
left = dry + wet
right = dry + np.concatenate([np.zeros(dl), wet[:-dl]])
st = np.stack([left, right], 1)
st -= st.mean(0)
st = np.tanh(st * 1.1) / np.tanh(1.1)
fade = np.ones(N); fi = idx(DUR - 0.6); fade[fi:] = np.linspace(1, 0, N - fi) ** 2
st *= fade[:, None]
st *= 10 ** (-1 / 20) / np.max(np.abs(st))
pcm = (st * 32767).astype('<i2')
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', sys.argv[1], f'{DUR}s')
