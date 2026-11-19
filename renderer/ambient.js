// Optional background soundscapes, synthesised live with the Web Audio API (nothing to download, works offline).
// They run on their own AudioContext so the narrator's <audio> element is untouched.

export const SOUNDS = [
  { id: 'off', label: 'Off' },
  { id: 'rain', label: 'Light rain' },
  { id: 'brown', label: 'Brown noise' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'lofi', label: 'Lo-fi' },
];

function noiseBuffer(ctx, seconds, kind) {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * white) / 1.02; data[i] = last * 3.5; } else data[i] = white;
    }
    // Cross-fade the loop point so the buffer repeats without a click.
    const fade = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[data.length - fade + i] * (1 - t);
    }
  }
  return buffer;
}

export function createAmbient() {
  let ctx = null;
  let master = null;
  let current = null; // { id, stop() }
  let wanted = 'off';
  let volume = 0.35;
  let running = false;

  function ensure() {
    if (ctx) return ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    return ctx;
  }

  function loopNoise(kind) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx, 6, kind);
    src.loop = true;
    src.start();
    return src;
  }

  const builders = {
    brown() {
      const src = loopNoise('brown');
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
      const g = ctx.createGain(); g.gain.value = 0.9;
      src.connect(lp).connect(g).connect(master);
      return () => { src.stop(); g.disconnect(); };
    },
    rain() {
      const src = loopNoise('white');
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
      const g = ctx.createGain(); g.gain.value = 0.22;
      src.connect(hp).connect(lp).connect(g).connect(master);
      // soft low rumble underneath
      const rumble = loopNoise('brown');
      const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 300;
      const rg = ctx.createGain(); rg.gain.value = 0.25;
      rumble.connect(rl).connect(rg).connect(master);
      // sparse drops
      const timer = setInterval(() => {
        if (!ctx || ctx.state !== 'running') return;
        const osc = ctx.createOscillator(); const dg = ctx.createGain();
        osc.frequency.value = 1800 + Math.random() * 2600; osc.type = 'sine';
        const t = ctx.currentTime;
        dg.gain.setValueAtTime(0, t); dg.gain.linearRampToValueAtTime(0.025 * Math.random() + 0.01, t + 0.004); dg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        osc.connect(dg).connect(master); osc.start(t); osc.stop(t + 0.1);
      }, 70);
      return () => { clearInterval(timer); src.stop(); rumble.stop(); g.disconnect(); rg.disconnect(); };
    },
    ocean() {
      const src = loopNoise('brown');
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      const swell = ctx.createGain(); swell.gain.value = 0.55;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
      const depth = ctx.createGain(); depth.gain.value = 0.45;
      lfo.connect(depth).connect(swell.gain);
      const foam = loopNoise('white');
      const fh = ctx.createBiquadFilter(); fh.type = 'bandpass'; fh.frequency.value = 2400; fh.Q.value = 0.5;
      const fg = ctx.createGain(); fg.gain.value = 0.05;
      const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.09;
      const d2 = ctx.createGain(); d2.gain.value = 0.04;
      lfo2.connect(d2).connect(fg.gain);
      src.connect(lp).connect(swell).connect(master);
      foam.connect(fh).connect(fg).connect(master);
      lfo.start(); lfo2.start();
      return () => { src.stop(); foam.stop(); lfo.stop(); lfo2.stop(); swell.disconnect(); fg.disconnect(); };
    },
    lofi() {
      const bus = ctx.createGain(); bus.gain.value = 0.7;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 1100;
      bus.connect(tone).connect(master);
      // vinyl crackle
      const crackle = loopNoise('white');
      const ch = ctx.createBiquadFilter(); ch.type = 'highpass'; ch.frequency.value = 3500;
      const cg = ctx.createGain(); cg.gain.value = 0.012;
      crackle.connect(ch).connect(cg).connect(master);
      const chords = [[261.63, 329.63, 392, 493.88], [220, 261.63, 329.63, 392], [174.61, 220, 261.63, 329.63], [196, 246.94, 293.66, 349.23]];
      const beat = 60 / 72;
      let step = 0;
      let nextTime = ctx.currentTime + 0.1;
      const note = (freq, t, len, vol) => {
        const o = ctx.createOscillator(); const o2 = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'triangle'; o2.type = 'sine'; o.frequency.value = freq; o2.frequency.value = freq * 2.003;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.04); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g); o2.connect(g); g.connect(bus); o.start(t); o2.start(t); o.stop(t + len + 0.05); o2.stop(t + len + 0.05);
      };
      const kick = (t) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
        g.gain.setValueAtTime(0.28, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        o.connect(g).connect(bus); o.start(t); o.stop(t + 0.25);
      };
      const hat = (t, vol) => {
        const s = ctx.createBufferSource(); s.buffer = noiseBuffer(ctx, 0.1, 'white');
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
        const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        s.connect(f).connect(g).connect(bus); s.start(t); s.stop(t + 0.08);
      };
      const timer = setInterval(() => {
        if (!ctx) return;
        while (nextTime < ctx.currentTime + 0.6) {
          const bar = Math.floor(step / 4) % chords.length; const inBar = step % 4;
          if (inBar === 0) chords[bar].forEach((f, i) => note(f * (i === 0 ? 0.5 : 1), nextTime + i * 0.035, beat * 3.6, i === 0 ? 0.09 : 0.05));
          if (inBar === 0 || inBar === 2) kick(nextTime);
          hat(nextTime + beat / 2, inBar % 2 ? 0.05 : 0.03);
          nextTime += beat; step += 1;
        }
      }, 120);
      return () => { clearInterval(timer); crackle.stop(); bus.disconnect(); cg.disconnect(); };
    },
  };

  function swapTo(id) {
    if (current) { try { current.stop(); } catch { /* already stopped */ } current = null; }
    if (id !== 'off' && builders[id] && ensure()) current = { id, stop: builders[id]() };
  }

  function apply() {
    if (wanted === 'off' && !ctx) return;
    if (!ensure()) return;
    const audible = running && wanted !== 'off';
    if (audible && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (audible && (!current || current.id !== wanted)) swapTo(wanted);
    if (!audible && current && wanted === 'off') swapTo('off');
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(audible ? volume : 0, t, audible ? 0.6 : 0.4);
    if (!audible && current) {
      // Free the CPU once the fade-out has finished.
      const gone = current;
      setTimeout(() => { if (current === gone && !running) { swapTo('off'); ctx?.suspend().catch(() => {}); } }, 1800);
    }
  }

  return {
    /** Which soundscape is selected ('off' disables it). */
    setSound(id) { wanted = builders[id] ? id : 'off'; apply(); },
    setVolume(v) { volume = Math.min(1, Math.max(0, v)); if (ctx) master.gain.setTargetAtTime(running && wanted !== 'off' ? volume : 0, ctx.currentTime, 0.1); },
    /** Call with true while the narrator is playing, false when paused. */
    setActive(on) { running = Boolean(on); apply(); },
    get sound() { return wanted; },
  };
}
