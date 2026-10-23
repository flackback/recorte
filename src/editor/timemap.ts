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
    // First span that ends (on the output timeline) after `output`; spans are in output order.
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const span = spans[middle];
      if (output < span.output + (span.end - span.start) / span.rate) high = middle;
      else low = middle + 1;
    }
    if (low === spans.length) return spans[spans.length - 1].end;
    const span = spans[low];
    return span.start + Math.max(0, output - span.output) * span.rate;
  }

  /** Output time for a source time; a time inside a cut maps to where the cut was. */
  toOutput(source: number): number {
    const spans = this.spans;
    const index = this.firstEnding(source, true);
    if (index === spans.length) {
      const last = spans[spans.length - 1];
      return last ? last.output + (last.end - last.start) / last.rate : 0;
    }
    const span = spans[index];
    return source < span.start ? span.output : span.output + (source - span.start) / span.rate;
  }

  /** Playback rate at a source time: 1 unless it is in a sped-up stretch. */
  rateAt(source: number): number {
    const span = this.spans[this.firstEnding(source, false)];
    return span && source >= span.start ? span.rate : 1;
  }

  /**
   * Where playback should be for a source time: itself if kept, otherwise the start of the next
   * kept span, or null past the end.
   */
  playable(source: number): number | null {
    const span = this.spans[this.firstEnding(source, false)];
    if (!span) return null;
    return source < span.start ? span.start : source;
  }

  /** Index of the first span ending after `source` (or at it, if `inclusive`); spans.length if none. */
  private firstEnding(source: number, inclusive: boolean) {
    const spans = this.spans;
    let low = 0;
    let high = spans.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const end = spans[middle].end;
      if (inclusive ? source <= end : source < end) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}
