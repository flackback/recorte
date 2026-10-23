import type { AudioSource } from "./audio-source";
import { decoderConfig } from "./exporter";
import { readSamples, type ByteSource, type Mp4Track } from "./mp4";

/**
 * Small frames for the timeline, decoded from keyframes only and read one at a time, so it takes
 * a fraction of a second even for long takes.
 */
export async function thumbnails(source: ByteSource, track: Mp4Track, count = 48): Promise<{ t: number; image: ImageBitmap }[]> {
  const keys: number[] = [];
  for (let i = 0; i < track.count; i++) if (track.sync[i]) keys.push(i);
  const step = Math.max(1, Math.floor(keys.length / count));
  const picked = keys.filter((_, index) => index % step === 0);

  const result: { t: number; image: ImageBitmap }[] = [];
  const pending: Promise<void>[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1000;
      pending.push(
        createImageBitmap(frame, { resizeHeight: 88, resizeQuality: "medium" })
          .then((image) => void result.push({ t, image }))
          .finally(() => frame.close()),
      );
    },
    error: () => undefined,
  });
  try {
    decoder.configure(decoderConfig(track));
    // Each keyframe decodes on its own; flushing between them resets the reference chain.
    for (const index of picked) {
      const [data] = await readSamples(source, track, index, index + 1);
      decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: track.times[index], data }));
      await decoder.flush().catch(() => undefined);
    }
    await Promise.all(pending);
  } catch (error) {
    // Nobody gets the frames decoded so far: release them with the decoder.
    await Promise.allSettled(pending);
    for (const { image } of result) image.close();
    throw error;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
  return result.sort((a, b) => a.t - b.t);
}

/** Peak level per bucket over the take, mixing every audio source given, read a minute at a time. */
export async function waveform(sources: AudioSource[], durationMs: number, buckets = 1600): Promise<Float32Array | null> {
  if (!sources.length) return null;
  const peaks = new Float32Array(buckets);
  const bucketMs = durationMs / buckets;
  const step = 60_000;
  for (const audio of sources) {
    for (let start = 0; start < durationMs; start += step) {
      const end = Math.min(durationMs, start + step);
      let buffer: AudioBuffer;
      try {
        buffer = await audio.read(start, end);
      } catch {
        break;
      }
      const data = buffer.getChannelData(0);
      const perMs = buffer.sampleRate / 1000;
      const first = Math.floor(start / bucketMs);
      const last = Math.min(buckets - 1, Math.floor((end - 1) / bucketMs));
      for (let bucket = first; bucket <= last; bucket++) {
        const from = Math.max(0, Math.floor((bucket * bucketMs - start) * perMs));
        const to = Math.min(data.length, Math.floor(((bucket + 1) * bucketMs - start) * perMs));
        let peak = 0;
        for (let i = from; i < to; i += 4) peak = Math.max(peak, Math.abs(data[i]));
        peaks[bucket] = Math.max(peaks[bucket], peak);
      }
    }
  }
  // Normalize so quiet recordings still show a readable shape.
  let max = 0;
  for (const peak of peaks) max = Math.max(max, peak);
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] = Math.sqrt(peaks[i] / max);
  return peaks;
}
