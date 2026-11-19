// Calm generative music + flight sound effects, all synthesized with Web Audio (no audio files).
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// slow, open chords in D (root note first, an octave low as a soft drone)
const CHORDS = [
  [38, 57, 62, 64, 66, 69], // Dadd9
  [35, 54, 59, 62, 64, 66], // Bm11
  [31, 55, 59, 62, 66, 71], // Gmaj7
  [33, 57, 61, 64, 66, 69], // A6/9
];
const CHORD_LEN = 9;
const MELODY = [62, 64, 66, 69, 71, 74, 76, 78, 81]; // D major pentatonic

export function makeReverb(ctx, seconds = 3.6) {
  const rate = ctx.sampleRate, len = Math.floor(rate * seconds), buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

// music engine: schedule notes ahead of time into `out` (dry) and `wet` (reverb send)
export function makeMusic(ctx, out, wet) {
  let nextChordAt = ctx.currentTime + 0.2, chord = 0, nextBellAt = ctx.currentTime + 3;

  function pad(midi, t0, dur, vol) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 3.5);
    g.gain.setValueAtTime(vol, t0 + dur);
    g.gain.linearRampToValueAtTime(0, t0 + dur + 5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 800 + Math.random() * 500; lp.Q.value = 0.4;
    for (const [type, det, v] of [['sine', -5, 1], ['triangle', 6, 0.3]]) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = type; o.frequency.value = hz(midi); o.detune.value = det + (Math.random() - 0.5) * 4;
      og.gain.value = v;
      o.connect(og).connect(lp);
      o.start(t0); o.stop(t0 + dur + 5.2);
    }
    lp.connect(g); g.connect(out); g.connect(wet);
  }

  function bell(midi, t0, vol) {
    const g = ctx.createGain(), f = hz(midi);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.4);
    for (const [r, v] of [[1, 1], [2, 0.3], [3.01, 0.12], [4.2, 0.05]]) {
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * r; og.gain.value = v;
      o.connect(og).connect(g);
      o.start(t0); o.stop(t0 + 3.5);
    }
    const dry = ctx.createGain(); dry.gain.value = 0.55;
    g.connect(dry).connect(out); g.connect(wet);
  }

  function scheduleUntil(t) {
    // after a pause (muted / hidden tab) skip what was missed instead of playing it all at once
    if (nextChordAt < ctx.currentTime) nextChordAt = ctx.currentTime + 0.1;
    if (nextBellAt < ctx.currentTime) nextBellAt = ctx.currentTime + 1;
    while (nextChordAt < t) {
      const notes = CHORDS[chord % CHORDS.length];
      notes.forEach((m, i) => pad(m, nextChordAt, CHORD_LEN, i === 0 ? 0.05 : 0.028));
      nextChordAt += CHORD_LEN; chord++;
    }
    while (nextBellAt < t) {
      const n = Math.random() < 0.35 ? 2 + Math.floor(Math.random() * 2) : 1; // sometimes a short phrase
      let i = Math.floor(Math.random() * MELODY.length);
      for (let k = 0; k < n; k++) {
        bell(MELODY[clamp(i, 0, MELODY.length - 1)], nextBellAt + k * 0.42, 0.05 + Math.random() * 0.03);
        i += Math.random() < 0.5 ? -1 : 1;
      }
      nextBellAt += 3 + Math.random() * 4.5;
    }
  }
  return { scheduleUntil, bell };
}

export function createAudio() {
  let ctx = null, master, musicBus, sfxBus, wet, music;
  let windGainA, windFiltA, windGainB, windFiltB, flutterDepth;
  let muted = false, varioAt = 0, wasThermal = false, wasCloud = false;
  try { muted = localStorage.getItem('zephyr-muted') === '1'; } catch (_) {}

  function noiseSource() {
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    return s;
  }

  function start() {
    if (ctx) { ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.85; musicBus.connect(master);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 1; sfxBus.connect(master);
    const rev = makeReverb(ctx), revOut = ctx.createGain();
    revOut.gain.value = 0.5; rev.connect(revOut).connect(master);
    wet = rev;
    music = makeMusic(ctx, musicBus, wet);

    // wind: a band of noise that rises with speed, plus a hissing rush when fast
    const nA = noiseSource(), nB = noiseSource();
    windFiltA = ctx.createBiquadFilter(); windFiltA.type = 'bandpass'; windFiltA.Q.value = 0.7; windFiltA.frequency.value = 400;
    windGainA = ctx.createGain(); windGainA.gain.value = 0;
    nA.connect(windFiltA).connect(windGainA).connect(sfxBus);
    windFiltB = ctx.createBiquadFilter(); windFiltB.type = 'highpass'; windFiltB.frequency.value = 2500;
    windGainB = ctx.createGain(); windGainB.gain.value = 0;
    // sail flutter: a fast wobble on the rush
    const flutter = ctx.createGain(); flutter.gain.value = 1;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 17;
    flutterDepth = ctx.createGain(); flutterDepth.gain.value = 0;
    lfo.connect(flutterDepth).connect(flutter.gain);
    nB.connect(windFiltB).connect(flutter).connect(windGainB).connect(sfxBus);
    nA.start(); nB.start(); lfo.start();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend(); else if (!muted) ctx.resume();
    });
    chord([62, 66, 69, 74], 0.18, 0.07);
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem('zephyr-muted', m ? '1' : '0'); } catch (_) {}
    if (!ctx) return;
    master.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.15);
    if (m) setTimeout(() => muted && ctx.suspend(), 600); else ctx.resume();
  }

  // ── one-shot effects
  function chord(notes, gap, vol) {
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    notes.forEach((m, i) => music.bell(m, t + i * gap, vol));
  }
  function beep(f, vol) {
    const t = ctx.currentTime, g = ctx.createGain(), o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * 1.03, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g); g.connect(sfxBus); g.connect(wet);
    o.start(t); o.stop(t + 0.2);
  }
  function whoosh(vol = 0.22, dur = 1.3) {
    const t = ctx.currentTime, s = noiseSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1400, t + dur * 0.45); f.frequency.exponentialRampToValueAtTime(350, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(sfxBus);
    s.start(t); s.stop(t + dur + 0.05);
  }
  const sfx = {
    bump() {
      if (!ctx) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.25);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.4);
      whoosh(0.12, 0.45);
    },
    fall() { if (ctx) whoosh(0.28, 1.0); },
    respawn() { chord([69, 74, 78, 81], 0.12, 0.06); },
    tick() { chord([86], 0, 0.05); },
  };

  // per-frame: music scheduling, wind, vario, and edge-triggered cues
  function update(s) {
    if (!ctx || muted) return;
    const now = ctx.currentTime;
    music.scheduleUntil(now + 1.5);
    const k = clamp((s.speed - 14) / 42, 0, 1), fly = s.flying ? 1 : 0.25;
    windGainA.gain.setTargetAtTime((0.04 + k * 0.2 + s.cloud * 0.06 + Math.abs(s.bank) * 0.03) * fly, now, 0.25);
    windFiltA.frequency.setTargetAtTime(320 + k * 1100 + s.cloud * 200, now, 0.3);
    windGainB.gain.setTargetAtTime(k * k * 0.1 * fly, now, 0.3);
    windFiltB.frequency.setTargetAtTime(2200 + k * 2600, now, 0.3);
    flutterDepth.gain.setTargetAtTime(k * k * 0.6, now, 0.3);
    if (!s.flying) return;
    // gentle variometer: soft beeps that quicken and rise with the climb
    const thermal = s.lift > 1.5;
    if (thermal && s.vy > 0.6 && now >= varioAt) {
      beep(560 + s.vy * 65, 0.05);
      varioAt = now + clamp(0.6 - s.vy * 0.07, 0.2, 0.6);
    }
    if (thermal && !wasThermal) chord([74, 78, 81], 0.14, 0.05);
    wasThermal = thermal;
    const cloud = s.cloud > 0.35;
    if (cloud && !wasCloud) whoosh();
    wasCloud = cloud;
  }

  return { start, update, setMuted, get muted() { return muted; }, sfx };
}
