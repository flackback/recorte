import { demux } from "./exporter";

/**
 * Small frames for the timeline, decoded from keyframes only so it takes a fraction of a second
 * even for long takes.
 */
export async function thumbnails(recording: ArrayBuffer, size: { width: number; height: number }, count = 48): Promise<{ t: number; image: ImageBitmap }[]> {
  const { config, chunks } = await demux(recording, size);
  const keys = chunks.filter((chunk) => chunk.type === "key");
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
  decoder.configure(config);
  // Each keyframe decodes on its own; flushing between them resets the reference chain.
  for (const chunk of picked) {
    decoder.decode(chunk);
    await decoder.flush().catch(() => undefined);
  }
  await Promise.all(pending);
  decoder.close();
  return result.sort((a, b) => a.t - b.t);
}

/** Peak level per bucket over the take, mixing every audio source given. */
export async function waveform(sources: ArrayBuffer[], durationMs: number, buckets = 1600): Promise<Float32Array | null> {
  if (!sources.length) return null;
  const context = new OfflineAudioContext(1, 1, 8000);
  const peaks = new Float32Array(buckets);
  for (const bytes of sources) {
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes.slice(0));
    } catch {
      continue;
    }
    const data = buffer.getChannelData(0);
    const perBucket = (buffer.sampleRate * durationMs) / 1000 / buckets;
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = Math.floor(bucket * perBucket);
      const end = Math.min(data.length, Math.floor((bucket + 1) * perBucket));
      let peak = 0;
      for (let i = start; i < end; i += 4) peak = Math.max(peak, Math.abs(data[i]));
      peaks[bucket] = Math.max(peaks[bucket], peak);
    }
  }
  // Normalize so quiet recordings still show a readable shape.
  let max = 0;
  for (const peak of peaks) max = Math.max(max, peak);
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] = Math.sqrt(peaks[i] / max);
  return peaks;
}
