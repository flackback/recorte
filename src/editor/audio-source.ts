import { readMp4, readSamples, urlSource, type ByteSource, type Mp4Track } from "./mp4";

/**
 * Audio read a stretch at a time, so hour-long recordings never sit whole in memory: WAV files
 * (microphone, system sound) and the AAC track of an MP4 (older recordings).
 */
export type AudioSource = {
  sampleRate: number;
  channels: number;
  durationMs: number;
  /** PCM for [startMs, endMs), at the source's own rate; silence where there is no audio. */
  read(startMs: number, endMs: number): Promise<AudioBuffer>;
};

function emptyBuffer(channels: number, sampleRate: number, startMs: number, endMs: number) {
  const length = Math.max(1, Math.round(((endMs - startMs) / 1000) * sampleRate));
  return new AudioBuffer({ length, numberOfChannels: Math.max(1, channels), sampleRate });
}

// ---------- WAV ----------

/**
 * A WAV file. Its header may say the data is empty if the recording was interrupted (the sizes are
 * written at the end); the data then runs to the end of the file.
 */
export async function wavSource(source: ByteSource): Promise<AudioSource> {
  const head = await source.read(0, Math.min(source.size, 4096));
  const data = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Arquivo WAV inválido.");
  let at = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 48000;
  let bits = 16;
  let dataStart = -1;
  let dataSize = 0;
  while (at + 8 <= head.length) {
    const id = tag(at);
    const size = data.getUint32(at + 4, true);
    if (id === "fmt ") {
      format = data.getUint16(at + 8, true);
      channels = data.getUint16(at + 10, true);
      sampleRate = data.getUint32(at + 12, true);
      bits = data.getUint16(at + 22, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the subformat GUID.
      if (format === 0xfffe && size >= 40) format = data.getUint16(at + 32, true);
    } else if (id === "data") {
      dataStart = at + 8;
      dataSize = size;
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (dataStart < 0) throw new Error("O WAV não tem dados de áudio.");
  const frameBytes = (bits / 8) * channels;
  if (dataSize === 0 || dataSize === 0xffffffff || dataStart + dataSize > source.size) dataSize = source.size - dataStart;
  const frames = Math.floor(dataSize / frameBytes);

  return {
    sampleRate,
    channels,
    durationMs: (frames / sampleRate) * 1000,
    async read(startMs, endMs) {
      const buffer = emptyBuffer(channels, sampleRate, startMs, endMs);
      const first = Math.round((startMs / 1000) * sampleRate);
      const from = Math.max(0, first);
      const to = Math.min(frames, first + buffer.length);
      if (to <= from) return buffer;
      const bytes = await source.read(dataStart + from * frameBytes, (to - from) * frameBytes);
      const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const out = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
      const offset = from - first;
      const count = Math.floor(bytes.length / frameBytes);
      for (let frame = 0; frame < count; frame++) {
        for (let channel = 0; channel < channels; channel++) {
          const p = frame * frameBytes + channel * (bits / 8);
          let value: number;
          if (format === 3) value = bits === 64 ? pcm.getFloat64(p, true) : pcm.getFloat32(p, true);
          else if (bits === 16) value = pcm.getInt16(p, true) / 32768;
          else if (bits === 24) value = ((pcm.getUint8(p) | (pcm.getUint8(p + 1) << 8) | (pcm.getInt8(p + 2) << 16)) / 8388608);
          else if (bits === 32) value = pcm.getInt32(p, true) / 2147483648;
          else value = (pcm.getUint8(p) - 128) / 128;
          out[channel][offset + frame] = value;
        }
      }
      return buffer;
    },
  };
}

// ---------- AAC in MP4 ----------

/** AAC frames that are decoded before the wanted stretch, so the decoder's overlap settles. */
const PREROLL_FRAMES = 2;

export function trackAudioSource(source: ByteSource, track: Mp4Track): AudioSource {
  const sampleRate = track.sampleRate || 48000;
  const channels = track.channels || 2;
  const last = track.count - 1;
  const durationMs = last >= 0 ? (track.times[last] + track.durations[last]) / 1000 : 0;

  return {
    sampleRate,
    channels,
    durationMs,
    async read(startMs, endMs) {
      const buffer = emptyBuffer(channels, sampleRate, startMs, endMs);
      if (!track.count) return buffer;
      const startUs = startMs * 1000;
      const endUs = endMs * 1000;
      // Samples are in time order for audio.
      let from = 0;
      while (from < track.count - 1 && track.times[from + 1] <= startUs) from++;
      from = Math.max(0, from - PREROLL_FRAMES);
      let to = from;
      while (to < track.count && track.times[to] < endUs) to++;
      if (to <= from) return buffer;

      const chunks = await readSamples(source, track, from, to);
      const decoded: AudioData[] = [];
      let failure: Error | null = null;
      const decoder = new AudioDecoder({
        output: (data) => decoded.push(data),
        error: (error) => (failure = error instanceof Error ? error : new Error(String(error))),
      });
      decoder.configure({ codec: track.codec, sampleRate, numberOfChannels: channels, description: track.description ?? undefined });
      chunks.forEach((data, index) => {
        const i = from + index;
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: track.times[i], duration: track.durations[i], data }));
      });
      await decoder.flush().catch((error) => (failure ??= error));
      decoder.close();
      if (failure) throw failure;

      const startFrame = Math.round((startMs / 1000) * sampleRate);
      for (const data of decoded) {
        const at = Math.round((data.timestamp / 1e6) * sampleRate) - startFrame;
        const plane = new Float32Array(data.numberOfFrames);
        for (let channel = 0; channel < channels; channel++) {
          data.copyTo(plane, { planeIndex: Math.min(channel, data.numberOfChannels - 1), format: "f32-planar" });
          const out = buffer.getChannelData(channel);
          const skip = Math.max(0, -at);
          const count = Math.min(plane.length - skip, out.length - Math.max(0, at));
          if (count > 0) out.set(plane.subarray(skip, skip + count), Math.max(0, at));
        }
        data.close();
      }
      return buffer;
    },
  };
}

/** The audio of a file: WAV directly, or the audio track of an MP4. Null when it has none. */
export async function openAudio(url: string): Promise<AudioSource | null> {
  const source = await urlSource(url);
  const head = await source.read(0, 12);
  if (String.fromCharCode(...head.subarray(0, 4)) === "RIFF") return wavSource(source);
  const { tracks } = await readMp4(source);
  const track = tracks.find((candidate) => candidate.kind === "audio" && candidate.codec.startsWith("mp4a"));
  return track ? trackAudioSource(source, track) : null;
}

/**
 * Mono PCM at `rate` for the whole source, decoded a minute at a time (for speech recognition and
 * silence detection, which want the full track but at a low rate).
 */
export async function readMono(audio: AudioSource, rate: number, durationMs = audio.durationMs): Promise<Float32Array> {
  const out = new Float32Array(Math.ceil((durationMs / 1000) * rate));
  const step = 60_000;
  for (let start = 0; start < durationMs; start += step) {
    const end = Math.min(durationMs, start + step);
    const piece = await audio.read(start, end);
    const length = Math.max(1, Math.round(((end - start) / 1000) * rate));
    const context = new OfflineAudioContext(1, length, rate);
    const node = context.createBufferSource();
    node.buffer = piece;
    node.connect(context.destination);
    node.start();
    const rendered = (await context.startRendering()).getChannelData(0);
    out.set(rendered.subarray(0, Math.min(rendered.length, out.length - Math.round((start / 1000) * rate))), Math.round((start / 1000) * rate));
  }
  return out;
}
