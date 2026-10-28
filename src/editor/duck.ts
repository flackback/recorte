import type { AudioSource } from "./audio-source";
import type { MediaEdit } from "./project";
import type { TimeMap } from "./timemap";

/**
 * Music ducking: the background music lowers while the microphone has voice and comes back up in
 * the pauses. The voice is found once per microphone file; the music's gain is then worked out
 * per frame of the output timeline, shared by the preview and the export.
 */

export const DUCK_FRAME_MS = 20;
/** How far the music goes down under the voice. */
const DEPTH_DB = -12;
/** Voice keeps the music down this long after it stops, so it doesn't pump between words. */
const HOLD_MS = 200;
const ATTACK_MS = 120;
const RELEASE_MS = 400;

/** RMS level of every 20 ms frame of the microphone, read a minute at a time. */
export async function voiceLevels(audio: AudioSource, durationMs: number): Promise<Float32Array> {
  const levels = new Float32Array(Math.ceil(durationMs / DUCK_FRAME_MS));
  const step = 60_000;
  for (let start = 0; start < durationMs; start += step) {
    const end = Math.min(durationMs, start + step);
    const buffer = await audio.read(start, end);
    const data = buffer.getChannelData(0);
    const size = Math.max(1, Math.round((buffer.sampleRate * DUCK_FRAME_MS) / 1000));
    const first = Math.round(start / DUCK_FRAME_MS);
    for (let frame = 0; frame * size < data.length && first + frame < levels.length; frame++) {
      const to = Math.min(data.length, (frame + 1) * size);
      let sum = 0;
      for (let i = frame * size; i < to; i++) sum += data[i] * data[i];
      levels[first + frame] = Math.sqrt(sum / (to - frame * size));
    }
  }
  return levels;
}

/**
 * Which frames have voice (1) or not (0). The threshold adapts to the microphone like
 * `findSilences`: well above its own noise floor and not far below its speech. A lone loud frame
 * (a key click) is not voice.
 */
export function voiceActivity(levels: Float32Array): Uint8Array {
  const voice = new Uint8Array(levels.length);
  const sorted = Float32Array.from(levels).sort();
  if (!sorted.length) return voice;
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.9)];
  // Steady sound with no clear speech over it: nothing tells voice apart.
  if (speech < floor * 4) return voice;
  const threshold = Math.max(floor * 3, speech * 0.1, 0.002);
  const loud = (frame: number) => frame >= 0 && frame < levels.length && levels[frame] >= threshold;
  for (let frame = 0; frame < levels.length; frame++) {
    if (loud(frame) && (loud(frame - 1) || loud(frame + 1))) voice[frame] = 1;
  }
  return voice;
}

/**
 * The music's gain (1 = untouched) per 20 ms frame of the output timeline, from the microphone's
 * voice frames (on the microphone file's clock). The microphone is heard only in kept stretches at
 * normal speed, moved by its lane's shift and silent inside its lane's cuts; elsewhere there is no
 * voice. Down and up are straight ramps in dB.
 */
export function duckGains(voice: Uint8Array, time: TimeMap, edit: MediaEdit): Float32Array {
  // Past the end the music comes back up over the closing card.
  const frames = Math.ceil((time.duration + HOLD_MS + RELEASE_MS) / DUCK_FRAME_MS);
  const gains = new Float32Array(frames);
  const down = (-DEPTH_DB * DUCK_FRAME_MS) / ATTACK_MS;
  const up = (-DEPTH_DB * DUCK_FRAME_MS) / RELEASE_MS;
  const holdFrames = Math.round(HOLD_MS / DUCK_FRAME_MS);
  let span = 0;
  let level = 0;
  let quiet = Infinity;
  for (let frame = 0; frame < frames; frame++) {
    const output = frame * DUCK_FRAME_MS;
    while (span < time.spans.length - 1 && output >= time.spans[span].output + (time.spans[span].end - time.spans[span].start) / time.spans[span].rate) span++;
    const current = time.spans[span];
    let speaking = false;
    if (current && current.rate === 1 && output < time.duration) {
      const source = current.start + (output - current.output);
      const at = Math.floor((source - edit.shift) / DUCK_FRAME_MS);
      speaking = at >= 0 && at < voice.length && voice[at] === 1 && !edit.cuts.some((cut) => source >= cut.start && source < cut.end);
    }
    quiet = speaking ? 0 : quiet + 1;
    level = quiet <= holdFrames ? Math.max(DEPTH_DB, level - down) : Math.min(0, level + up);
    gains[frame] = 10 ** (level / 20);
  }
  return gains;
}

/** The music's gain at `outputMs`, between frames by a straight line. */
export function duckAt(gains: Float32Array, outputMs: number): number {
  const at = outputMs / DUCK_FRAME_MS;
  if (!(at >= 0) || at >= gains.length - 1) return 1;
  const frame = Math.floor(at);
  return gains[frame] + (gains[frame + 1] - gains[frame]) * (at - frame);
}

/**
 * Puts the music's gain on `param` for a stretch of `seconds` that starts at `outputMs` on the
 * output timeline: one ramp per frame where the gain changes, none where it holds.
 */
export function scheduleDuck(param: AudioParam, gains: Float32Array, outputMs: number, seconds: number) {
  param.setValueAtTime(duckAt(gains, outputMs), 0);
  // Before and after the timeline the music is untouched.
  const gain = (frame: number) => (frame >= 0 && frame < gains.length ? gains[frame] : 1);
  const time = (frame: number) => (frame * DUCK_FRAME_MS - outputMs) / 1000;
  const first = Math.max(0, Math.floor(outputMs / DUCK_FRAME_MS) + 1);
  const last = Math.min(gains.length, Math.ceil((outputMs + seconds * 1000) / DUCK_FRAME_MS));
  let anchored = -Infinity;
  for (let frame = first; frame <= last; frame++) {
    if (gain(frame) === gain(frame - 1)) continue;
    // A ramp runs from the event before it: start it where the gain last held.
    if (anchored !== frame - 1 && time(frame - 1) > 0) param.setValueAtTime(gain(frame - 1), time(frame - 1));
    param.linearRampToValueAtTime(gain(frame), time(frame));
    anchored = frame;
  }
}
