/**
 * Click and keyboard sounds, synthesized so no third-party samples are needed: a short tick for
 * mouse clicks and a soft thock for key presses, each with slight random variation.
 */

function buffer(context: BaseAudioContext, seconds: number, fill: (t: number, i: number) => number) {
  const length = Math.ceil(seconds * context.sampleRate);
  const result = context.createBuffer(1, length, context.sampleRate);
  const data = result.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = fill(i / context.sampleRate, i);
  return result;
}

export function clickSound(context: BaseAudioContext): AudioBuffer {
  let low = 0;
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
  private click: AudioBuffer | null = null;
  private keys: AudioBuffer[] = [];
  private last = -1;

  private ensure() {
    if (!this.context) {
      this.context = new AudioContext();
      this.click = clickSound(this.context);
      this.keys = keySounds(this.context);
    }
    return this.context;
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
  update(t: number, clicks: number[], keys: number[], options: { click: boolean; key: boolean }) {
    const from = this.last;
    this.last = t;
    if (from < 0 || t < from || t - from > 250 || !(options.click || options.key)) return;
    this.ensure();
    if (options.click) for (const time of clicks) if (time > from && time <= t) this.play(this.click!, 0.6);
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
