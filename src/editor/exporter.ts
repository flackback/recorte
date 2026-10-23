/**
 * Renders the edited take to MP4 or GIF: decodes the recording (and webcam) frame by frame,
 * composites each output frame with the same Renderer as the preview, encodes with WebCodecs and
 * streams the file to disk as it is muxed.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { Muxer, StreamTarget } from "mp4-muxer";

import { joinPath, type Take } from "../types";
import { openAudio, type AudioSource } from "./audio-source";
import { cardLength, frameState, outputMoment, overlayText, sceneSource, totalDuration, type CardView, type Scene } from "./composition";
import { OverlayPainter } from "./overlay";
import { outputSize, type Aspect } from "./project";
import { Renderer } from "./renderer";
import { clickSound, keySounds } from "./sounds";
import { readMp4, readSamples, urlSource, type ByteSource, type Mp4Track } from "./mp4";

export type ExportOptions = {
  format: "mp4" | "gif";
  longSide: number;
  fps: number;
  /** Overrides the edit's aspect for this file (vertical for Reels, for example). */
  aspect?: Aspect;
  /** Keeps the MP4 under this size by lowering the video bitrate. */
  maxBytes?: number;
};
export type ExportProgress = { phase: "preparing" | "audio" | "video" | "finishing"; done: number; total: number };

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
/** Keyframe every 2 s keeps seeking in players snappy without bloating the file. */
const KEYFRAME_SECONDS = 2;
export const WRITE_CHUNK = 4 * 1024 * 1024;
const MUSIC_FADE = 1.5;
/** Sound is mixed and encoded this many seconds at a time, so memory stays small for long takes. */
const MIX_BLOCK = 30;

export class ExportCancelled extends Error {
  constructor() {
    super("Exportação cancelada");
  }
}

/** Rejects as soon as the export is cancelled, even if `promise` never settles. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ExportCancelled());
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new ExportCancelled());
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

/** Smallest H.264 level that fits the frame size and macroblock rate. */
function avcLevel(width: number, height: number, fps: number): string {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = frame * fps;
  const levels: [string, number, number][] = [
    ["28", 8192, 245760], // 4.0
    ["2a", 8704, 522240], // 4.2
    ["32", 22080, 589824], // 5.0
    ["33", 36864, 983040], // 5.1
    ["34", 36864, 2073600], // 5.2
    ["3c", 139264, 4177920], // 6.0
  ];
  return (levels.find(([, maxFrame, maxRate]) => frame <= maxFrame && rate <= maxRate) ?? levels[levels.length - 1])[0];
}

/** ~0.1 bit per pixel per frame: crisp text without huge files. */
export function videoBitrate(width: number, height: number, fps: number) {
  return Math.round(Math.min(60e6, Math.max(4e6, width * height * fps * 0.1)));
}

export const AUDIO_BITRATE = 192_000;

/** Video bits per second that keep the whole file under `maxBytes`, with a small margin. */
export function cappedBitrate(maxBytes: number, seconds: number, audio: boolean) {
  return Math.max(150_000, Math.floor((maxBytes * 8 * 0.92) / Math.max(1, seconds) - (audio ? AUDIO_BITRATE : 0)));
}

async function videoEncoderConfig(width: number, height: number, fps: number, cap: number | null): Promise<VideoEncoderConfig> {
  const level = avcLevel(width, height, fps);
  const bitrate = cap === null ? videoBitrate(width, height, fps) : Math.min(videoBitrate(width, height, fps), cap);
  for (const profile of ["6400", "4d00", "4200"]) {
    for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
      const config: VideoEncoderConfig = {
        codec: `avc1.${profile}${level}`,
        width,
        height,
        bitrate,
        // A size limit needs a steady rate; otherwise quality can vary with the content.
        bitrateMode: cap === null ? "variable" : "constant",
        framerate: fps,
        hardwareAcceleration,
        avc: { format: "avc" },
      };
      const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (support?.supported) return config;
    }
  }
  throw new Error(`Este computador não consegue codificar H.264 em ${width}×${height} a ${fps} fps.`);
}

async function audioEncoderConfig(): Promise<{ config: AudioEncoderConfig; codec: "aac" | "opus" } | null> {
  for (const [codec, muxerCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]] as const) {
    const config = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: AUDIO_BITRATE };
    const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
    if (support?.supported) return { config, codec: muxerCodec };
  }
  return null;
}

async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Não foi possível ler ${path}`);
  return response.arrayBuffer();
}

/** Whether the export has any sound at all. */
export function hasAudio(scene: Scene) {
  const { take, project } = scene;
  return (
    (take.systemAudio && project.audio.system > 0) ||
    (Boolean(take.mic) && project.audio.mic > 0) ||
    Boolean(project.audio.music) ||
    (project.audio.clickSound && scene.clicks.length > 0) ||
    (project.audio.keySound && scene.keys.length > 0)
  );
}

const fileUrl = (take: Take, file: string) => convertFileSrc(joinPath(take.dir, file));

/** The system sound: its own WAV in new takes, the video's audio track in older ones. */
function systemAudio(take: Take): Promise<AudioSource | null> {
  if (take.systemFile) return openAudio(fileUrl(take, take.systemFile));
  return take.systemAudio ? openAudio(fileUrl(take, take.video)) : Promise.resolve(null);
}

/** The microphone, enhanced when that option is on and the enhanced file exists. */
async function micAudio(take: Take, enhanced: boolean): Promise<AudioSource | null> {
  if (!take.mic) return null;
  if (enhanced) {
    const better = await openAudio(fileUrl(take, "mic.enhanced.wav")).catch(() => null);
    if (better) return better;
  }
  return openAudio(fileUrl(take, take.mic));
}

type Mixer = { blocks: number; block(index: number): Promise<AudioBuffer> };

/**
 * The output's sound track at 48 kHz stereo, a block at a time: every kept span of system audio
 * and microphone with their volumes, background music looped and faded out, and click and key
 * sounds at their moments. Sped-up stretches stay silent.
 */
async function createMixer(scene: Scene): Promise<Mixer | null> {
  const { take, project, time } = scene;
  if (!hasAudio(scene) || time.duration <= 0) return null;
  // The recording's sound starts after the opening card; music plays over everything.
  const offset = cardLength(project.cards.intro) / 1000;
  const total = totalDuration(scene) / 1000;

  const tracks: { audio: AudioSource; volume: number }[] = [];
  if (project.audio.system > 0) {
    const audio = await systemAudio(take).catch(() => null);
    if (audio) tracks.push({ audio, volume: project.audio.system });
  }
  if (project.audio.mic > 0) {
    const audio = await micAudio(take, project.audio.enhance).catch(() => null);
    if (audio) tracks.push({ audio, volume: project.audio.mic });
  }
  // Music is a short file the user picked; it is decoded whole, once.
  let music: AudioBuffer | null = null;
  if (project.audio.music) {
    const bytes = await fetchBytes(joinPath(take.dir, project.audio.music));
    music = await new OfflineAudioContext(CHANNELS, 1, SAMPLE_RATE).decodeAudioData(bytes);
  }
  const clicks = project.audio.clickSound ? scene.clicks.filter((click) => click.b === "l").map((click) => click.t) : [];
  const keys = project.audio.keySound ? scene.keys.map((key) => key.t) : [];

  return {
    blocks: Math.ceil(total / MIX_BLOCK),
    async block(index) {
      const start = index * MIX_BLOCK;
      const end = Math.min(total, start + MIX_BLOCK);
      const mixer = new OfflineAudioContext(CHANNELS, Math.max(1, Math.round((end - start) * SAMPLE_RATE)), SAMPLE_RATE);

      for (const track of tracks) {
        const gain = mixer.createGain();
        gain.gain.value = track.volume;
        gain.connect(mixer.destination);
        for (const span of time.spans) {
          if (span.rate !== 1) continue;
          const spanStart = offset + span.output / 1000;
          const spanEnd = spanStart + (span.end - span.start) / 1000;
          const from = Math.max(start, spanStart);
          const to = Math.min(end, spanEnd);
          if (to <= from) continue;
          const sourceStart = span.start + (from - spanStart) * 1000;
          const buffer = await track.audio.read(sourceStart, sourceStart + (to - from) * 1000);
          const node = mixer.createBufferSource();
          node.buffer = buffer;
          node.connect(gain);
          node.start(from - start);
        }
      }

      if (music) {
        const volume = project.audio.musicVolume;
        const fadeStart = Math.max(0, total - MUSIC_FADE);
        const level = (t: number) => volume * (t < fadeStart ? 1 : Math.max(0, (total - t) / MUSIC_FADE));
        const gain = mixer.createGain();
        gain.gain.setValueAtTime(level(start), 0);
        if (fadeStart < end) {
          gain.gain.setValueAtTime(level(Math.max(start, fadeStart)), Math.max(0, fadeStart - start));
          gain.gain.linearRampToValueAtTime(level(end), end - start);
        }
        gain.connect(mixer.destination);
        const node = mixer.createBufferSource();
        node.buffer = music;
        node.loop = true;
        node.connect(gain);
        node.start(0, start % music.duration);
      }

      const schedule = (sounds: AudioBuffer[], times: number[], volume: number) => {
        times.forEach((t, index) => {
          if (time.playable(t) !== t || time.rateAt(t) !== 1) return;
          const at = offset + time.toOutput(t) / 1000;
          if (at < start || at >= end) return;
          const node = mixer.createBufferSource();
          node.buffer = sounds[index % sounds.length];
          const gain = mixer.createGain();
          gain.gain.value = volume;
          node.connect(gain).connect(mixer.destination);
          node.start(at - start);
        });
      };
      if (clicks.length) schedule([clickSound(mixer, project.audio.clickTone)], clicks, 0.6);
      if (keys.length) schedule(keySounds(mixer), keys, 0.5);

      return mixer.startRendering();
    },
  };
}

/** The video track of a file, indexed for reading a piece at a time. */
export async function openVideo(url: string): Promise<{ source: ByteSource; track: Mp4Track }> {
  const source = await urlSource(url);
  const track = (await readMp4(source)).tracks.find((candidate) => candidate.kind === "video");
  if (!track?.count) throw new Error("O arquivo não tem quadros de vídeo.");
  if (!track.codec.startsWith("avc")) throw new Error(`Formato de vídeo não suportado: ${track.codec}.`);
  return { source, track };
}

export const decoderConfig = (track: Mp4Track): VideoDecoderConfig => ({
  codec: track.codec,
  codedWidth: track.width,
  codedHeight: track.height,
  description: track.description ?? undefined,
});

/**
 * Hands out the latest decoded frame at or before a time, decoding ahead only as far as needed.
 * Screen recordings have a variable frame rate (no new frame while nothing changes), so one
 * source frame can serve many output frames.
 */
class FrameSource {
  private queue: VideoFrame[] = [];
  /** Next sample to read from the file. */
  private next: number;
  /** Read but not yet given to the decoder. */
  private pending: EncodedVideoChunk[] = [];
  private reading = false;
  private flushing: Promise<void> | null = null;
  private finished = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private decoder: VideoDecoder;

  constructor(private source: ByteSource, private track: Mp4Track, startUs: number) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.queue.push(frame);
        this.notify();
      },
      error: (error) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.notify();
      },
    });
    this.decoder.configure(decoderConfig(track));
    this.decoder.addEventListener("dequeue", () => this.notify());
    // Start at the last keyframe before the trim, so the frames before it aren't decoded for nothing.
    let start = 0;
    for (let index = 0; index < track.count; index++) {
      if (track.times[index] > startUs) break;
      if (track.sync[index]) start = index;
    }
    this.next = start;
  }

  /** Reads the next samples from the file in the background. */
  private readAhead() {
    if (this.reading || this.next >= this.track.count || this.pending.length > 60) return;
    const from = this.next;
    const to = Math.min(this.track.count, from + 90);
    this.next = to;
    this.reading = true;
    readSamples(this.source, this.track, from, to).then(
      (data) => {
        data.forEach((bytes, k) => {
          const i = from + k;
          this.pending.push(new EncodedVideoChunk({ type: this.track.sync[i] ? "key" : "delta", timestamp: this.track.times[i], duration: this.track.durations[i], data: bytes }));
        });
        this.reading = false;
        this.notify();
      },
      (error) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
        this.reading = false;
        this.notify();
      },
    );
  }

  private notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private sleep() {
    return new Promise<void>((resolve) => (this.wake = resolve));
  }

  async frameAt(us: number): Promise<VideoFrame> {
    for (;;) {
      if (this.failure) throw this.failure;
      while (this.queue.length >= 2 && this.queue[1].timestamp <= us) this.queue.shift()!.close();
      const last = this.queue[this.queue.length - 1];
      if (last && (last.timestamp > us || this.finished)) return this.queue[0];
      if (this.finished) throw new Error("A gravação não tem quadros de vídeo.");

      this.readAhead();
      if (this.pending.length) {
        if (this.decoder.decodeQueueSize < 4 && this.queue.length < 12) this.decoder.decode(this.pending.shift()!);
        else await this.sleep();
      } else if (this.reading || this.next < this.track.count) {
        await this.sleep();
      } else if (!this.flushing) {
        this.flushing = this.decoder.flush().then(
          () => {
            this.finished = true;
            this.notify();
          },
          (error) => {
            this.failure ??= error instanceof Error ? error : new Error(String(error));
            this.notify();
          },
        );
      } else {
        await this.sleep();
      }
    }
  }

  close() {
    for (const frame of this.queue) frame.close();
    this.queue = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

/** Streams output to disk in order; the MP4 muxer seeks back once at the end to patch sizes. */
export class DiskWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private failure: unknown = null;
  /** Bytes handed over but not yet written. */
  private pending = 0;

  constructor(readonly id: number) {}

  write(data: Uint8Array, position: number) {
    const copy = data.slice();
    this.pending += copy.length;
    this.chain = this.chain.then(() =>
      invoke("export_write", copy, { headers: { "x-export-id": String(this.id), "x-position": String(position) } })
        .catch((error) => {
          this.failure ??= error;
        })
        .finally(() => (this.pending -= copy.length)),
    );
  }

  /** Waits while too much is queued, so a fast producer doesn't fill the memory. */
  async throttle(limit = 64 * 1024 * 1024) {
    if (this.pending > limit) await this.chain;
    if (this.failure) throw new Error(`Falha ao gravar o arquivo: ${this.failure}`);
  }

  async drain() {
    await this.chain;
    if (this.failure) throw new Error(`Falha ao gravar o arquivo: ${this.failure}`);
  }
}

/** Renders output frames in order, from the recording and (if shown) the webcam. */
class FrameRenderer {
  readonly canvas: OffscreenCanvas;
  private renderer: Renderer | null = null;
  private screen: FrameSource | null = null;
  private webcam: FrameSource | null = null;
  private overlay: OverlayPainter;

  constructor(private scene: Scene, private output: { width: number; height: number }) {
    this.canvas = new OffscreenCanvas(output.width, output.height);
    this.overlay = new OverlayPainter(output.width, output.height);
  }

  async start(signal: AbortSignal) {
    const { take, project } = this.scene;
    this.renderer = await abortable(Renderer.create(this.canvas), signal);
    const background = await abortable(backgroundImage(this.scene), signal);
    if (background) this.renderer.setBackground(background);
    const screen = await abortable(openVideo(fileUrl(take, take.video)), signal);
    this.screen = new FrameSource(screen.source, screen.track, (this.scene.time.spans[0]?.start ?? 0) * 1000);
    if (take.webcam && project.webcam.visible) {
      const camera = await abortable(openVideo(fileUrl(take, take.webcam)), signal);
      this.webcam = new FrameSource(camera.source, camera.track, 0);
    }
  }

  /** Draws the output frame for source time `t` (ms) into the canvas. */
  async draw(t: number, signal: AbortSignal, card: CardView | null = null) {
    const scene = this.scene;
    const screen = await abortable(this.screen!.frameAt(t * 1000), signal);
    let camera: VideoFrame | null = null;
    if (this.webcam) {
      const cameraTime = Math.max(0, t - (scene.take.webcamOffsetMs ?? 0));
      camera = await abortable(this.webcam.frameAt(cameraTime * 1000), signal);
    }
    if (this.overlay.paint(overlayText(scene, t), scene.project, card)) this.renderer!.setOverlay(this.overlay.canvas);
    this.renderer!.render(screen, frameState(scene, t, this.output, this.overlay.visible), camera);
  }

  close() {
    this.screen?.close();
    this.webcam?.close();
    this.renderer?.destroy();
  }
}

async function backgroundImage(scene: Scene): Promise<OffscreenCanvas | null> {
  const { background } = scene.project;
  if (background.kind !== "image" || !background.image) return null;
  const response = await fetch(convertFileSrc(joinPath(scene.take.dir, background.image)));
  const bitmap = await createImageBitmap(await response.blob());
  const scale = Math.min(1, 1920 / bitmap.width);
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d")!;
  if (background.blur > 0) {
    context.filter = `blur(${background.blur}px)`;
    const margin = background.blur * 2;
    context.drawImage(bitmap, -margin, -margin, canvas.width + margin * 2, canvas.height + margin * 2);
  } else {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }
  bitmap.close();
  return canvas;
}

/** Exports the scene's edit. Resolves with the saved file's path. */
export async function exportVideo(
  scene: Scene,
  options: ExportOptions,
  onProgress: (progress: ExportProgress) => void,
  signal: AbortSignal,
): Promise<string> {
  return options.format === "gif" ? exportGif(scene, options, onProgress, signal) : exportMp4(scene, options, onProgress, signal);
}

async function exportMp4(scene: Scene, options: ExportOptions, onProgress: (progress: ExportProgress) => void, signal: AbortSignal): Promise<string> {
  const { take } = scene;
  const check = () => {
    if (signal.aborted) throw new ExportCancelled();
  };
  const output = outputSize(options.aspect ?? scene.project.aspect, sceneSource(scene), options.longSide);
  const fps = options.fps;
  const totalFrames = Math.max(1, Math.round((totalDuration(scene) / 1000) * fps));

  onProgress({ phase: "preparing", done: 0, total: totalFrames });
  const audioSetup = hasAudio(scene) ? await audioEncoderConfig() : null;
  const mixer = audioSetup ? await abortable(createMixer(scene), signal) : null;
  const cap = options.maxBytes ? cappedBitrate(options.maxBytes, totalDuration(scene) / 1000, Boolean(audioSetup)) : null;
  const videoConfig = await videoEncoderConfig(output.width, output.height, fps, cap);
  check();

  const created = await invoke<{ id: number; path: string }>("export_create", { takeId: take.id, extension: "mp4" });
  const writer = new DiskWriter(created.id);
  const frames = new FrameRenderer(scene, output);
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let encodeError: Error | null = null;
  const fail = (error: unknown) => (encodeError ??= error instanceof Error ? error : new Error(String(error)));

  try {
    const muxer = new Muxer({
      target: new StreamTarget({ onData: (data, position) => writer.write(data, position), chunked: true, chunkSize: WRITE_CHUNK }),
      video: { codec: "avc", width: output.width, height: output.height, frameRate: fps },
      audio: audioSetup ? { codec: audioSetup.codec, sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS } : undefined,
      fastStart: false,
      firstTimestampBehavior: "offset",
    });

    // Audio first, a block at a time: it is fast, and lets the video loop run uninterrupted afterwards.
    if (audioSetup && mixer) {
      onProgress({ phase: "audio", done: 0, total: totalFrames });
      audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: fail });
      audioEncoder.configure(audioSetup.config);
      let written = 0;
      for (let index = 0; index < mixer.blocks; index++) {
        const mixed = await abortable(mixer.block(index), signal);
        check();
        const block = 4800;
        const left = mixed.getChannelData(0);
        const right = mixed.numberOfChannels > 1 ? mixed.getChannelData(1) : left;
        for (let offset = 0; offset < mixed.length; offset += block) {
          const length = Math.min(block, mixed.length - offset);
          const planar = new Float32Array(length * CHANNELS);
          planar.set(left.subarray(offset, offset + length), 0);
          planar.set(right.subarray(offset, offset + length), length);
          const data = new AudioData({
            format: "f32-planar",
            sampleRate: SAMPLE_RATE,
            numberOfFrames: length,
            numberOfChannels: CHANNELS,
            timestamp: Math.round((written / SAMPLE_RATE) * 1e6),
            data: planar,
          });
          audioEncoder.encode(data);
          data.close();
          written += length;
        }
        // Lets the encoder catch up so its queue doesn't hold the whole track.
        while (audioEncoder.encodeQueueSize > 50) await new Promise((resolve) => setTimeout(resolve, 5));
        if (encodeError) throw encodeError;
      }
      await abortable(audioEncoder.flush(), signal);
    }
    if (encodeError) throw encodeError;
    check();

    await frames.start(signal);
    videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: fail });
    videoEncoder.configure(videoConfig);
    const keyframeEvery = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));

    for (let index = 0; index < totalFrames; index++) {
      check();
      if (encodeError) throw encodeError;
      const moment = outputMoment(scene, (index * 1000) / fps);
      await frames.draw(moment.t, signal, moment.card);
      const frame = new VideoFrame(frames.canvas, { timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps) });
      videoEncoder.encode(frame, { keyFrame: index % keyframeEvery === 0 });
      frame.close();
      while (videoEncoder.encodeQueueSize > 4) {
        await abortable(new Promise((resolve) => videoEncoder!.addEventListener("dequeue", resolve, { once: true })), signal);
      }
      if (index % 5 === 0 || index === totalFrames - 1) onProgress({ phase: "video", done: index + 1, total: totalFrames });
    }

    onProgress({ phase: "finishing", done: totalFrames, total: totalFrames });
    await abortable(videoEncoder.flush(), signal);
    if (encodeError) throw encodeError;
    check();
    muxer.finalize();
    await writer.drain();
    return await invoke<string>("export_finish", { id: created.id });
  } catch (error) {
    await writer.drain().catch(() => undefined);
    await invoke("export_cancel", { id: created.id }).catch(() => undefined);
    throw error;
  } finally {
    frames.close();
    for (const encoder of [videoEncoder, audioEncoder]) {
      if (encoder && encoder.state !== "closed") encoder.close();
    }
  }
}

/** Animated GIF: frames read back from the GPU, one 256-color palette per frame. */
async function exportGif(scene: Scene, options: ExportOptions, onProgress: (progress: ExportProgress) => void, signal: AbortSignal): Promise<string> {
  const { take } = scene;
  const output = outputSize(options.aspect ?? scene.project.aspect, sceneSource(scene), options.longSide);
  const fps = options.fps;
  const totalFrames = Math.max(1, Math.round((totalDuration(scene) / 1000) * fps));
  onProgress({ phase: "preparing", done: 0, total: totalFrames });

  const created = await invoke<{ id: number; path: string }>("export_create", { takeId: take.id, extension: "gif" });
  const writer = new DiskWriter(created.id);
  const frames = new FrameRenderer(scene, output);
  const readback = new OffscreenCanvas(output.width, output.height);
  const context = readback.getContext("2d", { willReadFrequently: true })!;
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);

  try {
    await frames.start(signal);
    for (let index = 0; index < totalFrames; index++) {
      if (signal.aborted) throw new ExportCancelled();
      const moment = outputMoment(scene, (index * 1000) / fps);
      await frames.draw(moment.t, signal, moment.card);
      context.drawImage(frames.canvas, 0, 0);
      const { data } = context.getImageData(0, 0, output.width, output.height);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), output.width, output.height, { palette, delay });
      if (index % 3 === 0 || index === totalFrames - 1) onProgress({ phase: "video", done: index + 1, total: totalFrames });
      // Yield so the progress bar and cancel button stay responsive.
      if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    onProgress({ phase: "finishing", done: totalFrames, total: totalFrames });
    gif.finish();
    const bytes = gif.bytes();
    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) writer.write(bytes.subarray(offset, offset + WRITE_CHUNK), offset);
    await writer.drain();
    return await invoke<string>("export_finish", { id: created.id });
  } catch (error) {
    await writer.drain().catch(() => undefined);
    await invoke("export_cancel", { id: created.id }).catch(() => undefined);
    throw error;
  } finally {
    frames.close();
  }
}
