// Synthesized sound for EMBERLINE: WebAudio oscillators and filtered noise
// only, no audio files and no network. unlock() runs on the first user
// gesture; every method no-ops safely when the context is unavailable.
export function createAudio() {
  let ctx = null;
  let master = null;

  function ensure() {
    if (ctx) return ctx;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      ctx = new AudioCtx();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
    } catch (err) {
      ctx = null;
    }
    return ctx;
  }

  function tone(freq, dur, type, gain, slideTo, delay) {
    const ac = ctx;
    if (!ac || !master) return;
    try {
      const t0 = ac.currentTime + (delay || 0);
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch (err) { /* sound is never fatal */ }
  }

  function noise(dur, filterFreq, gain, delay, filterType) {
    const ac = ctx;
    if (!ac || !master) return;
    try {
      const t0 = ac.currentTime + (delay || 0);
      const len = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buffer = ac.createBuffer(1, len, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = filterType || 'lowpass';
      filter.frequency.value = filterFreq;
      const g = ac.createGain();
      g.gain.setValueAtTime(gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    } catch (err) { /* sound is never fatal */ }
  }

  function shotNoise(kind) {
    if (kind === 'pistol') { noise(0.09, 3200, 0.5); tone(320, 0.07, 'square', 0.25, 90); }
    else if (kind === 'smg') { noise(0.06, 4200, 0.35); tone(420, 0.05, 'square', 0.18, 120); }
    else { noise(0.12, 1800, 0.6); tone(180, 0.11, 'sawtooth', 0.3, 60); }
  }

  return {
    unlock() {
      const ac = ensure();
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
    },
    shot(kind) {
      if (!ensure()) return;
      shotNoise(kind || 'rifle');
    },
    reload() {
      if (!ensure()) return;
      tone(900, 0.04, 'square', 0.15, 0, 0);
      tone(650, 0.04, 'square', 0.15, 0, 0.16);
    },
    hit() {
      if (!ensure()) return;
      tone(1250, 0.06, 'sine', 0.3, 0, 0);
    },
    kill() {
      if (!ensure()) return;
      tone(1250, 0.06, 'sine', 0.3, 0, 0);
      tone(880, 0.1, 'sine', 0.3, 0, 0.07);
    },
    dryfire() {
      if (!ensure()) return;
      tone(1400, 0.03, 'square', 0.12, 0, 0);
    },
    plant() {
      if (!ensure()) return;
      tone(740, 0.3, 'sine', 0.25, 0, 0);
    },
    beep(final) {
      if (!ensure()) return;
      tone(final ? 1500 : 980, 0.09, 'sine', 0.3, 0, 0);
    },
    explosion() {
      if (!ensure()) return;
      noise(0.7, 400, 0.9, 0, 'lowpass');
      tone(90, 0.6, 'sine', 0.5, 30);
    },
    roundWin() {
      if (!ensure()) return;
      tone(523, 0.12, 'sine', 0.3, 0, 0);
      tone(659, 0.12, 'sine', 0.3, 0, 0.12);
      tone(784, 0.2, 'sine', 0.3, 0, 0.24);
    },
    roundLose() {
      if (!ensure()) return;
      tone(392, 0.14, 'sine', 0.3, 0, 0);
      tone(330, 0.14, 'sine', 0.3, 0, 0.14);
      tone(262, 0.22, 'sine', 0.3, 0, 0.28);
    },
    click() {
      if (!ensure()) return;
      tone(1000, 0.03, 'square', 0.12, 0, 0);
    },
    footstep() {
      if (!ensure()) return;
      noise(0.05, 300, 0.08, 0, 'lowpass');
    },
  };
}
