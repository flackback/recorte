import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Muxer, StreamTarget } from "mp4-muxer";

import { DiskWriter, WRITE_CHUNK } from "./editor/exporter";
import { readMp4, readSamples, urlSource, type Mp4Track } from "./editor/mp4";
import { joinPath, type Take } from "./types";

/**
 * Joins a recording's video segments into its single video file, copying the encoded frames
 * without re-encoding, and reading a few megabytes at a time. Segments come from a normal stop
 * (just after recording) or from an interrupted recording that was recovered.
 */
export async function joinSegments(take: Take, onProgress: (fraction: number) => void): Promise<Take> {
  const segments = take.segments ?? [];
  if (!segments.length) return take;

  const parts: { track: Mp4Track; source: Awaited<ReturnType<typeof urlSource>>; startUs: number }[] = [];
  for (const segment of segments) {
    const source = await urlSource(convertFileSrc(joinPath(take.dir, segment.file.replace(/\//g, "\\"))));
    const track = (await readMp4(source)).tracks.find((candidate) => candidate.kind === "video");
    if (track?.count) parts.push({ track, source, startUs: segment.startMs * 1000 });
  }
  if (!parts.length) throw new Error("Os segmentos da gravação não têm vídeo.");
  const first = parts[0].track;
  const total = parts.reduce((sum, part) => sum + part.track.count, 0);

  const created = await invoke<{ id: number }>("asset_create", { dir: take.dir, name: take.video });
  const writer = new DiskWriter(created.id);
  try {
    const muxer = new Muxer({
      target: new StreamTarget({ onData: (data, position) => writer.write(data, position), chunked: true, chunkSize: WRITE_CHUNK }),
      video: { codec: "avc", width: first.width || take.width, height: first.height || take.height, frameRate: take.fps },
      fastStart: false,
      firstTimestampBehavior: "offset",
    });
    let done = 0;
    let lastDecode = -Infinity;
    for (const [index, part] of parts.entries()) {
      const { track, source, startUs } = part;
      const batch = 240;
      for (let from = 0; from < track.count; from += batch) {
        const to = Math.min(track.count, from + batch);
        const data = await readSamples(source, track, from, to);
        for (let i = from; i < to; i++) {
          // Decode times must keep increasing across segments, even if one overlaps the next a little.
          const decode = Math.max(startUs + track.decodeTimes[i], lastDecode + 1);
          lastDecode = decode;
          const meta = index === 0 && i === 0 ? { decoderConfig: { codec: first.codec, codedWidth: first.width, codedHeight: first.height, description: first.description ?? undefined } } : undefined;
          // The muxer takes the presentation time and derives the decode time from the offset.
          const offset = track.times[i] - track.decodeTimes[i];
          muxer.addVideoChunkRaw(data[i - from], track.sync[i] ? "key" : "delta", decode + offset, track.durations[i], meta, offset);
        }
        done += to - from;
        onProgress(done / total);
        await writer.throttle();
      }
    }
    muxer.finalize();
    await writer.drain();
    await invoke("export_finish", { id: created.id });
  } catch (error) {
    await writer.drain().catch(() => undefined);
    await invoke("export_cancel", { id: created.id }).catch(() => undefined);
    throw error;
  }
  return invoke<Take>("take_segments_joined", { dir: take.dir });
}
