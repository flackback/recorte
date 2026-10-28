/**
 * Reads MP4 files a piece at a time: only the index is parsed up front (moov, or moof boxes in
 * fragmented files), and sample data is read when needed. Recordings can be several gigabytes,
 * far more than fits in memory.
 */

export type ByteSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

/** A file served by the asset protocol, read with HTTP range requests. */
export async function urlSource(url: string): Promise<ByteSource> {
  const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (!probe.ok) throw new Error(`Não foi possível ler o arquivo (${probe.status}).`);
  const range = probe.headers.get("Content-Range");
  const size = range ? Number(range.split("/")[1]) : Number(probe.headers.get("Content-Length"));
  await probe.arrayBuffer();
  if (!Number.isFinite(size)) throw new Error("Tamanho do arquivo desconhecido.");
  return {
    size,
    async read(offset, length) {
      const total = Math.max(0, Math.min(size, offset + length) - offset);
      const result = new Uint8Array(total);
      // The asset protocol answers a range with at most about 1 MB, so ask until it is all here.
      let got = 0;
      while (got < total) {
        const response = await fetch(url, { headers: { Range: `bytes=${offset + got}-${offset + total - 1}` } });
        if (!response.ok) throw new Error(`Falha ao ler o arquivo (${response.status}).`);
        const piece = new Uint8Array(await response.arrayBuffer());
        if (response.status !== 206 && got === 0 && piece.length === size) {
          // A server that ignores ranges sends the whole file.
          result.set(piece.subarray(offset, offset + total));
          return result;
        }
        if (!piece.length) throw new Error("O arquivo terminou antes do esperado.");
        result.set(piece.subarray(0, total - got), got);
        got += piece.length;
      }
      return result;
    },
  };
}

export type Mp4Track = {
  id: number;
  kind: "video" | "audio" | "other";
  timescale: number;
  /** WebCodecs codec string, such as "avc1.640028" or "mp4a.40.2". */
  codec: string;
  /** avcC for H.264, AudioSpecificConfig for AAC. */
  description: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  count: number;
  /** Per sample, in decode order. Times are presentation times in microseconds. */
  offsets: Float64Array;
  sizes: Uint32Array;
  times: Float64Array;
  /** Decode times in microseconds (differ from `times` only when frames are reordered). */
  decodeTimes: Float64Array;
  durations: Float64Array;
  sync: Uint8Array;
};

export type Mp4 = { tracks: Mp4Track[]; fragmented: boolean };

// ---------- boxes ----------

type Box = { type: string; start: number; size: number; header: number };

const text = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const u64 = (data: DataView, at: number) => data.getUint32(at) * 2 ** 32 + data.getUint32(at + 4);

/** The boxes directly inside bytes[start, end). */
function children(bytes: Uint8Array, start: number, end: number): Box[] {
  const data = view(bytes);
  const result: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = data.getUint32(at);
    let header = 8;
    if (size === 1) {
      size = u64(data, at + 8);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) break;
    result.push({ type: text(bytes, at + 4), start: at, size, header });
    at += size;
  }
  return result;
}

const find = (bytes: Uint8Array, box: Box, type: string, skip = 0) => children(bytes, box.start + box.header + skip, box.start + box.size).find((child) => child.type === type);

/** Content start of a full box (after version and flags). */
const body = (box: Box) => box.start + box.header + 4;

// ---------- sample tables (moov) ----------

type Building = Omit<Mp4Track, "offsets" | "sizes" | "times" | "decodeTimes" | "durations" | "sync" | "count"> & {
  offsets: number[];
  sizes: number[];
  times: number[];
  decodeTimes: number[];
  durations: number[];
  sync: number[];
  /** Edit list shift in track units, subtracted from every time. */
  shift: number;
  defaults: { duration: number; size: number; flags: number };
  /** Next decode time for fragments, in track units. */
  decodeTime: number;
};

const hex = (value: number) => value.toString(16).padStart(2, "0");

function sampleEntry(bytes: Uint8Array, stsd: Box, track: Building) {
  const data = view(bytes);
  const entry = children(bytes, body(stsd) + 4, stsd.start + stsd.size)[0];
  if (!entry) return;
  const content = entry.start + entry.header;
  if (entry.type === "avc1" || entry.type === "avc3") {
    track.width = data.getUint16(content + 24);
    track.height = data.getUint16(content + 26);
    const avcC = children(bytes, content + 78, entry.start + entry.size).find((child) => child.type === "avcC");
    if (avcC) {
      const config = bytes.slice(avcC.start + avcC.header, avcC.start + avcC.size);
      track.description = config;
      track.codec = `avc1.${hex(config[1])}${hex(config[2])}${hex(config[3])}`;
    }
  } else if (entry.type === "mp4a") {
    // QuickTime sound descriptions (MOV files) are 16 (version 1) or 36 (version 2) bytes longer,
    // and may keep the esds inside a "wave" box.
    const version = data.getUint16(content + 8);
    track.channels = version === 2 ? data.getUint32(content + 40) : data.getUint16(content + 16);
    track.sampleRate = version === 2 ? data.getFloat64(content + 32) : data.getUint32(content + 24) / 65536;
    const inside = children(bytes, content + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), entry.start + entry.size);
    const wave = inside.find((child) => child.type === "wave");
    const esds = inside.find((child) => child.type === "esds") ?? (wave && find(bytes, wave, "esds"));
    const config = esds ? audioConfig(bytes, body(esds), esds.start + esds.size) : null;
    if (config) {
      track.description = config;
      track.codec = `mp4a.40.${config[0] >> 3}`;
    }
  } else {
    track.codec = entry.type;
  }
}

/** The AudioSpecificConfig inside an esds box's descriptors. */
function audioConfig(bytes: Uint8Array, start: number, end: number): Uint8Array | null {
  let at = start;
  const descriptor = () => {
    const tag = bytes[at++];
    let length = 0;
    for (let i = 0; i < 4; i++) {
      const byte = bytes[at++];
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length };
  };
  while (at < end) {
    const { tag, length } = descriptor();
    if (tag === 0x03) {
      const flags = bytes[at + 2];
      at += 3;
      if (flags & 0x80) at += 2;
      if (flags & 0x40) at += 1 + bytes[at];
      if (flags & 0x20) at += 2;
    } else if (tag === 0x04) {
      at += 13;
    } else if (tag === 0x05) {
      return bytes.slice(at, at + length);
    } else {
      at += length;
    }
  }
  return null;
}

function sampleTable(bytes: Uint8Array, stbl: Box, track: Building) {
  const data = view(bytes);
  const box = (type: string) => find(bytes, stbl, type);

  const stsd = box("stsd");
  if (stsd) sampleEntry(bytes, stsd, track);

  const stsz = box("stsz");
  if (!stsz) return;
  const uniform = data.getUint32(body(stsz));
  const count = data.getUint32(body(stsz) + 4);
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i++) sizes[i] = uniform || data.getUint32(body(stsz) + 8 + i * 4);

  // Decode times.
  const decode = new Array<number>(count);
  const durations = new Array<number>(count);
  const stts = box("stts");
  let index = 0;
  let time = 0;
  if (stts) {
    const entries = data.getUint32(body(stts));
    for (let e = 0; e < entries; e++) {
      const run = data.getUint32(body(stts) + 4 + e * 8);
      const delta = data.getUint32(body(stts) + 8 + e * 8);
      for (let i = 0; i < run && index < count; i++, index++) {
        decode[index] = time;
        durations[index] = delta;
        time += delta;
      }
    }
  }
  for (; index < count; index++) {
    decode[index] = time;
    durations[index] = 0;
  }

  // Presentation offsets.
  const presentation = decode.slice();
  const ctts = box("ctts");
  if (ctts) {
    const signed = bytes[ctts.start + ctts.header] === 1;
    const entries = data.getUint32(body(ctts));
    index = 0;
    for (let e = 0; e < entries; e++) {
      const run = data.getUint32(body(ctts) + 4 + e * 8);
      const offset = signed ? data.getInt32(body(ctts) + 8 + e * 8) : data.getUint32(body(ctts) + 8 + e * 8);
      for (let i = 0; i < run && index < count; i++, index++) presentation[index] += offset;
    }
  }

  // Keyframes; without stss every sample is one.
  const sync = new Array<number>(count).fill(box("stss") ? 0 : 1);
  const stss = box("stss");
  if (stss) {
    const entries = data.getUint32(body(stss));
    for (let e = 0; e < entries; e++) sync[data.getUint32(body(stss) + 4 + e * 4) - 1] = 1;
  }

  // File offsets: chunks hold runs of samples (stsc), starting at stco/co64.
  const chunkOffsets: number[] = [];
  const stco = box("stco");
  const co64 = box("co64");
  if (stco) {
    const entries = data.getUint32(body(stco));
    for (let e = 0; e < entries; e++) chunkOffsets.push(data.getUint32(body(stco) + 4 + e * 4));
  } else if (co64) {
    const entries = data.getUint32(body(co64));
    for (let e = 0; e < entries; e++) chunkOffsets.push(u64(data, body(co64) + 4 + e * 8));
  }
  const stsc = box("stsc");
  const runs: { first: number; perChunk: number }[] = [];
  if (stsc) {
    const entries = data.getUint32(body(stsc));
    for (let e = 0; e < entries; e++) runs.push({ first: data.getUint32(body(stsc) + 4 + e * 12), perChunk: data.getUint32(body(stsc) + 8 + e * 12) });
  }
  const offsets = new Array<number>(count);
  index = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && index < count; chunk++) {
    let run = runs[0];
    for (const candidate of runs) if (candidate.first - 1 <= chunk) run = candidate;
    let offset = chunkOffsets[chunk];
    for (let i = 0; i < (run?.perChunk ?? 1) && index < count; i++, index++) {
      offsets[index] = offset;
      offset += sizes[index];
    }
  }

  for (let i = 0; i < count; i++) {
    track.offsets.push(offsets[i] ?? 0);
    track.sizes.push(sizes[i]);
    track.times.push(presentation[i]);
    track.decodeTimes.push(decode[i]);
    track.durations.push(durations[i]);
    track.sync.push(sync[i]);
  }
}

function parseMoov(bytes: Uint8Array, moov: Box, tracks: Map<number, Building>) {
  const data = view(bytes);
  for (const trak of children(bytes, moov.start + moov.header, moov.start + moov.size)) {
    if (trak.type === "mvex") {
      for (const trex of children(bytes, trak.start + trak.header, trak.start + trak.size).filter((child) => child.type === "trex")) {
        const id = data.getUint32(body(trex));
        const track = tracks.get(id);
        if (track) track.defaults = { duration: data.getUint32(body(trex) + 8), size: data.getUint32(body(trex) + 12), flags: data.getUint32(body(trex) + 16) };
      }
      continue;
    }
    if (trak.type !== "trak") continue;
    const tkhd = find(bytes, trak, "tkhd");
    const mdia = find(bytes, trak, "mdia");
    if (!tkhd || !mdia) continue;
    const id = data.getUint32(body(tkhd) + (bytes[tkhd.start + tkhd.header] === 1 ? 16 : 8));
    const mdhd = find(bytes, mdia, "mdhd");
    const hdlr = find(bytes, mdia, "hdlr");
    const handler = hdlr ? text(bytes, body(hdlr) + 4) : "";
    const track: Building = {
      id,
      kind: handler === "vide" ? "video" : handler === "soun" ? "audio" : "other",
      timescale: mdhd ? data.getUint32(body(mdhd) + (bytes[mdhd.start + mdhd.header] === 1 ? 16 : 8)) : 1000,
      codec: "",
      description: null,
      width: 0,
      height: 0,
      sampleRate: 0,
      channels: 0,
      offsets: [],
      sizes: [],
      times: [],
      decodeTimes: [],
      durations: [],
      sync: [],
      shift: 0,
      defaults: { duration: 0, size: 0, flags: 0 },
      decodeTime: 0,
    };
    // An edit list may start the track later than its first sample (encoder priming).
    const elst = find(bytes, trak, "edts") && find(bytes, find(bytes, trak, "edts")!, "elst");
    if (elst) {
      const wide = bytes[elst.start + elst.header] === 1;
      const entries = data.getUint32(body(elst));
      for (let e = 0; e < entries; e++) {
        const at = body(elst) + 4 + e * (wide ? 20 : 12);
        const mediaTime = wide ? u64(data, at + 8) : data.getInt32(at + 4);
        // Skips empty edits (-1); the first real edit sets the shift.
        if (mediaTime !== -1 && mediaTime !== 0xffffffff) {
          track.shift = mediaTime;
          break;
        }
      }
    }
    const minf = find(bytes, mdia, "minf");
    const stbl = minf && find(bytes, minf, "stbl");
    if (stbl) sampleTable(bytes, stbl, track);
    tracks.set(id, track);
  }
}

// ---------- fragments (moof) ----------

function parseMoof(bytes: Uint8Array, moof: Box, fileOffset: number, tracks: Map<number, Building>) {
  const data = view(bytes);
  for (const traf of children(bytes, moof.start + moof.header, moof.start + moof.size).filter((child) => child.type === "traf")) {
    const tfhd = find(bytes, traf, "tfhd");
    if (!tfhd) continue;
    const flags = data.getUint32(tfhd.start + tfhd.header) & 0xffffff;
    let at = body(tfhd);
    const id = data.getUint32(at);
    at += 4;
    const track = tracks.get(id);
    if (!track) continue;
    let base = fileOffset + moof.start;
    if (flags & 0x01) {
      base = u64(data, at);
      at += 8;
    }
    if (flags & 0x02) at += 4;
    let duration = track.defaults.duration;
    let size = track.defaults.size;
    let sampleFlags = track.defaults.flags;
    if (flags & 0x08) {
      duration = data.getUint32(at);
      at += 4;
    }
    if (flags & 0x10) {
      size = data.getUint32(at);
      at += 4;
    }
    if (flags & 0x20) sampleFlags = data.getUint32(at);

    const tfdt = find(bytes, traf, "tfdt");
    if (tfdt) track.decodeTime = bytes[tfdt.start + tfdt.header] === 1 ? u64(data, body(tfdt)) : data.getUint32(body(tfdt));

    for (const trun of children(bytes, traf.start + traf.header, traf.start + traf.size).filter((child) => child.type === "trun")) {
      const runFlags = data.getUint32(trun.start + trun.header) & 0xffffff;
      const signed = bytes[trun.start + trun.header] === 1;
      let p = body(trun);
      const count = data.getUint32(p);
      p += 4;
      let offset = base;
      if (runFlags & 0x01) {
        offset = base + data.getInt32(p);
        p += 4;
      }
      let firstFlags: number | null = null;
      if (runFlags & 0x04) {
        firstFlags = data.getUint32(p);
        p += 4;
      }
      for (let i = 0; i < count; i++) {
        let sampleDuration = duration;
        let sampleSize = size;
        let flagsHere = i === 0 && firstFlags !== null ? firstFlags : sampleFlags;
        let cto = 0;
        if (runFlags & 0x100) {
          sampleDuration = data.getUint32(p);
          p += 4;
        }
        if (runFlags & 0x200) {
          sampleSize = data.getUint32(p);
          p += 4;
        }
        if (runFlags & 0x400) {
          flagsHere = data.getUint32(p);
          p += 4;
        }
        if (runFlags & 0x800) {
          cto = signed ? data.getInt32(p) : data.getUint32(p);
          p += 4;
        }
        track.offsets.push(offset);
        track.sizes.push(sampleSize);
        track.times.push(track.decodeTime + cto);
        track.decodeTimes.push(track.decodeTime);
        track.durations.push(sampleDuration);
        // Bit 16 of the sample flags marks a non-sync sample.
        track.sync.push((flagsHere >> 16) & 1 ? 0 : 1);
        offset += sampleSize;
        track.decodeTime += sampleDuration;
      }
    }
  }
}

// ---------- file ----------

/** Reads the index of an MP4: tracks, codec setup and where each sample is. */
export async function readMp4(source: ByteSource): Promise<Mp4> {
  const tracks = new Map<number, Building>();
  let fragmented = false;
  let at = 0;
  while (at + 8 <= source.size) {
    const head = await source.read(at, 16);
    const data = view(head);
    let size = data.getUint32(0);
    const type = text(head, 4);
    if (size === 1) size = u64(data, 8);
    // A size of 0 runs to the end of the file (an unfinished recording's mdat, for instance).
    else if (size === 0) size = source.size - at;
    if (size < 8) break;
    if (type === "moov" || type === "moof") {
      const bytes = await source.read(at, Math.min(size, source.size - at));
      const box = children(bytes, 0, bytes.length)[0];
      if (box && type === "moov") parseMoov(bytes, box, tracks);
      else if (box) {
        fragmented = true;
        parseMoof(bytes, box, at, tracks);
      }
    }
    at += size;
  }

  const result: Mp4Track[] = [];
  for (const track of tracks.values()) {
    const scale = 1e6 / track.timescale;
    const count = track.sizes.length;
    const times = new Float64Array(count);
    const decodeTimes = new Float64Array(count);
    const durations = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      times[i] = (track.times[i] - track.shift) * scale;
      decodeTimes[i] = (track.decodeTimes[i] - track.shift) * scale;
      durations[i] = track.durations[i] * scale;
    }
    result.push({
      id: track.id,
      kind: track.kind,
      timescale: track.timescale,
      codec: track.codec,
      description: track.description,
      width: track.width,
      height: track.height,
      sampleRate: track.sampleRate,
      channels: track.channels,
      count,
      offsets: Float64Array.from(track.offsets),
      sizes: Uint32Array.from(track.sizes),
      times,
      decodeTimes,
      durations,
      sync: Uint8Array.from(track.sync),
    });
  }
  return { tracks: result, fragmented };
}

/** Sample data for samples [from, to) of a track, read in as few requests as possible. */
export async function readSamples(source: ByteSource, track: Mp4Track, from: number, to: number): Promise<Uint8Array[]> {
  const result: Uint8Array[] = [];
  let index = from;
  while (index < to) {
    // One read covers consecutive samples while they sit close together, up to 8 MB.
    const start = track.offsets[index];
    let end = start + track.sizes[index];
    let last = index + 1;
    while (last < to && track.offsets[last] >= end && track.offsets[last] - end < 256 * 1024 && track.offsets[last] + track.sizes[last] - start < 8 * 1024 * 1024) {
      end = track.offsets[last] + track.sizes[last];
      last++;
    }
    const bytes = await source.read(start, end - start);
    for (let i = index; i < last; i++) {
      const at = track.offsets[i] - start;
      result.push(bytes.subarray(at, at + track.sizes[i]));
    }
    index = last;
  }
  return result;
}

/** The index of the sample shown at a time (the last one starting at or before it). */
export function sampleAt(track: Mp4Track, us: number): number {
  let low = 0;
  let high = track.count - 1;
  let found = 0;
  // Times are in decode order; for streams without reordering that is also time order.
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (track.times[middle] <= us) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
