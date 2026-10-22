import type { Project } from "./project";

export type Span = { start: number; end: number };

/**
 * Maps between the source timeline (the recording) and the output timeline (what is exported):
 * the trimmed range minus every cut, played back to back, with sped-up stretches shortened.
 */
export class TimeMap {
  /** Kept source ranges, in order, with their start on the output timeline and playback rate. */
  readonly spans: (Span & { output: number; rate: number })[] = [];
  readonly duration: number;

  constructor(project: Pick<Project, "trim" | "cuts"> & Partial<Pick<Project, "speed">>, extraCuts: Span[] = []) {
    const removed = [...project.cuts, ...extraCuts]
      .map((cut) => ({ start: Math.max(cut.start, project.trim.start), end: Math.min(cut.end, project.trim.end) }))
      .filter((cut) => cut.end > cut.start)
      .sort((a, b) => a.start - b.start);
    const kept: Span[] = [];
    let cursor = project.trim.start;
    for (const cut of removed) {
      if (cut.start > cursor) kept.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (project.trim.end > cursor) kept.push({ start: cursor, end: project.trim.end });

    const speeds = (project.speed ?? []).filter((range) => range.end > range.start && range.rate > 0).sort((a, b) => a.start - b.start);
    let output = 0;
    const push = (start: number, end: number, rate: number) => {
      if (end - start < 0.5) return;
      this.spans.push({ start, end, output, rate });
      output += (end - start) / rate;
    };
    for (const span of kept) {
      let at = span.start;
      for (const speed of speeds) {
        if (speed.end <= at || speed.start >= span.end) continue;
        push(at, Math.max(at, speed.start), 1);
        at = Math.max(at, speed.start);
        const end = Math.min(span.end, speed.end);
        push(at, end, speed.rate);
        at = end;
      }
      push(at, span.end, 1);
    }
    this.duration = output;
  }

  /** Source time for an output time. */
  toSource(output: number): number {
    const spans = this.spans;
    if (!spans.length) return 0;
    for (const span of spans) {
      if (output < span.output + (span.end - span.start) / span.rate) return span.start + Math.max(0, output - span.output) * span.rate;
    }
    return spans[spans.length - 1].end;
  }

  /** Output time for a source time; a time inside a cut maps to where the cut was. */
  toOutput(source: number): number {
    let result = 0;
    for (const span of this.spans) {
      if (source < span.start) return span.output;
      if (source <= span.end) return span.output + (source - span.start) / span.rate;
      result = span.output + (span.end - span.start) / span.rate;
    }
    return result;
  }

  /** Playback rate at a source time: 1 unless it is in a sped-up stretch. */
  rateAt(source: number): number {
    for (const span of this.spans) {
      if (source < span.start) break;
      if (source < span.end) return span.rate;
    }
    return 1;
  }

  /**
   * Where playback should be for a source time: itself if kept, otherwise the start of the next
   * kept span, or null past the end.
   */
  playable(source: number): number | null {
    for (const span of this.spans) {
      if (source < span.start) return span.start;
      if (source < span.end) return source;
    }
    return null;
  }
}
