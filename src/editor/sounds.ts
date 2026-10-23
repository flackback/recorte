/**
 * Click and keyboard sounds, synthesized so no third-party samples are needed: a choice of mouse
 * clicks and a soft thock for key presses, each with slight random variation.
 */

import type { ClickTone } from "./project";

function buffer(context: BaseAudioContext, seconds: number, fill: (t: number, i: number) => number) {
  const length = Math.ceil(seconds * context.sampleRate);
  const result = context.createBuffer(1, length, context.sampleRate);
  const data = result.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = fill(i / context.sampleRate, i);
  return result;
}

/** "tick": a crisp short click. "soft": a muted tap. "mech": a loud switch with its release. */
export function clickSound(context: BaseAudioContext, tone: ClickTone = "tick"): AudioBuffer {
  let low = 0;
  if (tone === "soft") {
    return buffer(context, 0.05, (t) => {
      const noise = Math.random() * 2 - 1;
      low += (noise - low) * 0.12;
      const body = Math.sin(2 * Math.PI * 520 * t) * Math.exp(-t / 0.008);
      return (body * 0.45 + low * Math.exp(-t / 0.004) * 0.9) * 0.7;
    });
  }
  if (tone === "mech") {
    const snap = (t: number, pitch: number) => (t < 0 ? 0 : Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t / 0.0018));
    return buffer(context, 0.09, (t) => {
      const noise = Math.random() * 2 - 1;
      low += (noise - low) * 0.5;
      const press = snap(t, 4200) * 0.6 + low * Math.exp(-t / 0.0015) * 0.8;
      // The switch springs back a moment later, a little quieter.
      const r = t - 0.055;
      const release = snap(r, 3600) * 0.35 + (r > 0 ? low * Math.exp(-r / 0.0012) * 0.4 : 0);
      return (press + release) * 0.85;
    });
  }
  return buffer(context, 0.04, (t) => {
    const noise = Math.random() * 2 - 1;
    low += (noise - low) * 0.35;
    const tick = Math.sin(2 * Math.PI * 3100 * t) * Math.exp(-t / 0.0025);
    const body = Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t / 0.006);
    return (tick * 0.5 + body * 0.35 + low * Math.exp(-t / 0.002) * 0.6) * 0.8;
  });
}

export function keySounds(context: BaseAudioContext, variants = 4): AudioBuffer[] {
  return Array.from({ length: variants }, (_, variant) => {
    let low = 0;
    const pitch = 260 + variant * 35;
    return buffer(context, 0.07, (t) => {
      const noise = Math.random() * 2 - 1;
      low += (noise - low) * 0.18;
      const press = low * Math.exp(-t / 0.004) * 1.4;
      const thock = Math.sin(2 * Math.PI * pitch * t) * Math.exp(-t / 0.012) * 0.5;
      // Release clack a moment later, quieter.
      const r = t - 0.045;
      const release = r > 0 ? low * Math.exp(-r / 0.003) * 0.5 : 0;
      return (press + thock + release) * 0.7;
    });
  });
}

/** Plays sounds live during preview playback, once per event as the playhead passes it. */
export class SoundPreview {
  private context: AudioContext | null = null;
  private clicks = new Map<ClickTone, AudioBuffer>();
  private keys: AudioBuffer[] = [];
  private last = -1;

  private ensure() {
    if (!this.context) {
      this.context = new AudioContext();
      this.keys = keySounds(this.context);
    }
    return this.context;
  }

  private click(tone: ClickTone) {
    const context = this.ensure();
    if (!this.clicks.has(tone)) this.clicks.set(tone, clickSound(context, tone));
    return this.clicks.get(tone)!;
  }

  /** Plays one click, so the user hears a tone when choosing it. */
  sample(tone: ClickTone) {
    this.play(this.click(tone), 0.6);
  }

  private play(sound: AudioBuffer, volume: number) {
    const context = this.ensure();
    const source = context.createBufferSource();
    source.buffer = sound;
    const gain = context.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(context.destination);
    source.start();
  }

  /** Call every frame while playing; plays events between the previous and current time. */
  update(t: number, clicks: number[], keys: number[], options: { click: boolean; tone: ClickTone; key: boolean }) {
    const from = this.last;
    this.last = t;
    if (from < 0 || t < from || t - from > 250 || !(options.click || options.key)) return;
    this.ensure();
    if (options.click) for (const time of clicks) if (time > from && time <= t) this.play(this.click(options.tone), 0.6);
    if (options.key) {
      keys.forEach((time, index) => {
        if (time > from && time <= t) this.play(this.keys[index % this.keys.length], 0.5);
      });
    }
  }

  reset() {
    this.last = -1;
  }
}
