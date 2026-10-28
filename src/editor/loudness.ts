/**
 * Loudness to a platform's standard: the integrated loudness of the whole mix is measured as
 * ITU-R BS.1770 defines it (the LUFS that YouTube and others normalize to), then a gain brings it
 * to the target while a limiter keeps the peaks under -1 dBFS.
 */

/** YouTube plays everything at about -14 LUFS; louder videos are turned down, quieter ones stay quiet. */
export const YOUTUBE_LUFS = -14;
/** Peak ceiling after the gain (-1.5 dBFS): AAC encoding raises peaks a little, and they must stay under -1. */
const CEILING = 0.841;
/** Never boost more than this: a near-silent mix would only get louder noise. */
const MAX_GAIN_DB = 20;

/** K-weighting for 48 kHz: a high shelf (the head's effect) then a high-pass (BS.1770-4). */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const HIGH_PASS = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private c: { b: number[]; a: number[] }) {}

  next(x: number) {
    const { b, a } = this.c;
    const y = b[0] * x + b[1] * this.x1 + b[2] * this.x2 - a[0] * this.y1 - a[1] * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Integrated loudness of 48 kHz audio fed in pieces, in order. */
export class LoudnessMeter {
  private filters: [Biquad, Biquad][] = [];
  /** Mean square of each 100 ms step, summed over the channels. */
  private steps: number[] = [];
  private stepSum = 0;
  private stepCount = 0;
  private readonly stepLength: number;

  constructor(sampleRate: number) {
    this.stepLength = Math.round(sampleRate / 10);
  }

  add(buffer: AudioBuffer) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    while (this.filters.length < channels.length) this.filters.push([new Biquad(SHELF), new Biquad(HIGH_PASS)]);
    for (let i = 0; i < buffer.length; i++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const [shelf, highPass] = this.filters[channel];
        const weighted = highPass.next(shelf.next(channels[channel][i]));
        this.stepSum += weighted * weighted;
      }
      if (++this.stepCount === this.stepLength) {
        this.steps.push(this.stepSum / this.stepLength);
        this.stepSum = 0;
        this.stepCount = 0;
      }
    }
  }

  /** LUFS over 400 ms blocks every 100 ms, gated at -70 LUFS and 10 LU under the mean. -Infinity if silent. */
  lufs(): number {
    const loudness = (power: number) => -0.691 + 10 * Math.log10(power);
    const blocks: number[] = [];
    for (let i = 3; i < this.steps.length; i++) blocks.push((this.steps[i - 3] + this.steps[i - 2] + this.steps[i - 1] + this.steps[i]) / 4);
    const audible = blocks.filter((power) => loudness(power) > -70);
    if (!audible.length) return -Infinity;
    const mean = audible.reduce((sum, power) => sum + power, 0) / audible.length;
    const gated = audible.filter((power) => loudness(power) > loudness(mean) - 10);
    return loudness(gated.reduce((sum, power) => sum + power, 0) / gated.length);
  }
}

/** The gain (linear) that brings `lufs` to `target`, within limits. */
export function loudnessGain(lufs: number, target = YOUTUBE_LUFS) {
  if (!Number.isFinite(lufs)) return 1;
  return 10 ** (Math.min(MAX_GAIN_DB, target - lufs) / 20);
}

/**
 * Applies a gain and keeps every sample under the ceiling: when a peak would go over, the gain
 * dips 2 ms ahead of it and recovers over ~80 ms. Blocks are processed in place and in order; the
 * look-ahead stays inside each block, so nothing is delayed (a final clamp covers block edges).
 */
export class GainLimiter {
  private readonly lookahead: number;
  private readonly release: number;
  private gain = 1;

  constructor(private gainValue: number, sampleRate: number) {
    this.lookahead = Math.max(1, Math.round(sampleRate * 0.002));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.08));
  }

  process(channels: Float32Array[]) {
    const length = channels[0].length;
    // The gain each sample needs to stay under the ceiling.
    const needed = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let peak = 0;
      for (const channel of channels) peak = Math.max(peak, Math.abs(channel[i] * this.gainValue));
      needed[i] = peak > CEILING ? CEILING / peak : 1;
    }
    // Sliding minimum of `needed` over the next `lookahead` samples (monotonic queue of indices).
    const queue = new Int32Array(length);
    let head = 0;
    let tail = 0;
    let next = 0;
    for (let i = 0; i < length; i++) {
      while (next < length && next <= i + this.lookahead) {
        while (tail > head && needed[queue[tail - 1]] >= needed[next]) tail--;
        queue[tail++] = next++;
      }
      while (queue[head] < i) head++;
      const target = needed[queue[head]];
      // Down at once (the look-ahead already gave it time), back up slowly.
      this.gain = target < this.gain ? target : this.gain + (target - this.gain) * this.release;
      const gain = this.gain * this.gainValue;
      for (const channel of channels) channel[i] = Math.max(-CEILING, Math.min(CEILING, channel[i] * gain));
    }
  }
}
