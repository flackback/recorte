/**
 * Composites one output frame on the GPU in a single pass: background, the recording in its frame
 * (with crop, tilt, zoom, lens, blurred regions, cursor, click effects), the webcam bubble and a
 * text overlay (keys, captions). Preview and export share this code, so both look identical.
 */

import type { Matte } from "./matte";
import { CLICK_DURATIONS, CLICK_STYLES, CURSOR_STYLES, TRANSITIONS, type ClickStyle, type CursorStyle, type Frame, type Rect, type TransitionKind, type WebcamBackground } from "./project";

export type CursorKind = "arrow" | "hand" | "text";

export type FrameState = {
  /** Output frame size in pixels; composition happens in this space. */
  output: { width: number; height: number };
  /** Full recording size, and the part of it kept (video pixels). */
  video: { width: number; height: number };
  crop: Rect | null;
  background: { kind: "gradient" | "image"; from: string; to: string; angle: number; padding: number; radius: number; shadow: number };
  frame: Frame;
  /** Degrees of 3D tilt; 0 is flat. */
  tilt: number;
  /** Camera zoom (1 = whole frame) and the point it centers on, in video pixels. */
  zoom: number;
  focus: [number, number];
  /** Cursor tip in video pixels; `scale` is relative to a normal-size cursor; `angle` turns it around the tip (radians, clockwise). */
  cursor: { x: number; y: number; scale: number; kind: CursorKind; style: CursorStyle; opacity: number; angle: number } | null;
  /** Clicks still playing: where, how long ago, and when they happened (source ms, which seeds confetti). */
  clicks: { x: number; y: number; age: number; at: number }[];
  clickStyle: ClickStyle;
  clickSize: number;
  /** Effect across a cut: `amount` rises to 1 at the seam and falls back; `phase` is -1 before it, 1 after. */
  transition: { kind: TransitionKind; amount: number; phase: number } | null;
  /** 0–1 dimming of everything but the area around the cursor. */
  spotlight: number;
  /** 0–1 strength of focus mode: a steady dim and blur of everything but a soft circle around the cursor. */
  focusMode: number;
  /** Magnifier at a point (video pixels); `amount` 0–1 animates it in and out; `shape` blends two LENS_SHAPES indexes. */
  lens: { x: number; y: number; magnification: number; amount: number; shape: [number, number, number] } | null;
  /** Cursor travel over the last frame (video pixels), for motion blur. */
  motion: [number, number] | null;
  /** Blurred areas in video pixels. */
  blurs: Rect[];
  /** Webcam bubble in output pixels. */
  webcam: {
    rect: Rect;
    /** Corner radius in output pixels. */
    radius: number;
    opacity: number;
    mirror: boolean;
    /** Border width in output pixels, and its color. */
    border: number;
    borderColor: string;
    shadow: number;
    /** Zoom into the camera picture (1 = all of it). */
    zoom: number;
    /** Behind the person: kept, blurred or removed (needs a matte from setWebcamMatte). */
    background: WebcamBackground;
    /** How far the webcam fills the frame (0–1); a removed background shows the frame's background there, not the screen. */
    full: number;
    /** Light and color temperature of the camera picture, each −1 to 1 (see webcamGrade). */
    light: number;
    warmth: number;
  } | null;
  /** Part of the output the screen is laid out in, as fractions; null is all of it. */
  area: Rect | null;
  /** Whether the text overlay canvas has content to draw. */
  overlay: boolean;
};

export type Layout = { content: Rect; box: Rect };

const MAX_CLICKS = 8;
const MAX_BLURS = 4;
/** Specks in a confetti burst. */
const CONFETTI = 14;
/** Each cursor sprite covers this many video pixels at scale 1, with the hotspot at its TIP. */
const CURSOR_BOX = 40;
const CURSOR_TIPS: Record<CursorKind, [number, number]> = { arrow: [8, 6], hand: [15, 7], text: [20, 20] };
const CURSOR_SLOTS: CursorKind[] = ["arrow", "hand", "text"];
/** Styles drawn as one picture for every kind, with the hotspot in the middle. */
const CURSOR_PICTURES: Partial<Record<CursorStyle, string>> = { pizza: "\u{1F355}", melon: "\u{1F349}", rocket: "\u{1F680}" };
const cursorTip = (style: CursorStyle, kind: CursorKind): [number, number] =>
  style === "classic" || style === "light" ? CURSOR_TIPS[kind] : [CURSOR_BOX / 2, CURSOR_BOX / 2];
const SPRITE = 256;
const LENS_RADIUS = 120;
/** Uniform vectors before the blur and click arrays. */
const FIXED_VECS = 21;
const UNIFORM_VECS = FIXED_VECS + MAX_BLURS + MAX_CLICKS;
/** Samples along the cursor's path for motion blur. */
const MOTION_SAMPLES = 10;

const SHADER = /* wgsl */ `
struct Uniforms {
  frame: vec4f,     // output w, h, output px per canvas px, zoom
  camera: vec4f,    // visible top-left (composed px), corner radius, shadow
  content: vec4f,   // screen content rect (composed px)
  bg_from: vec4f,   // rgb, kind (0 gradient, 1 image)
  bg_to: vec4f,     // rgb, gradient angle
  misc: vec4f,      // cursor visible, cursor box, click count, spotlight
  cursor: vec4f,    // cursor box top-left, cursor tip (composed px)
  crop: vec4f,      // kept part of the video as uv: u0, v0, u1, v1
  tilt: vec4f,      // rotation y, rotation x (radians), eye distance, frame kind
  lens: vec4f,      // center (composed px), radius, magnification
  webcam: vec4f,    // bubble rect (output px)
  webcam2: vec4f,   // visible, corner radius, overlay visible, cursor slot
  bg_image: vec4f,  // output uv -> image uv: scale xy, offset xy
  box: vec4f,       // outer frame box (composed px)
  extra: vec4f,     // blur count, blur strength (uv), webcam shadow, webcam mirrored
  cam_style: vec4f, // webcam border rgb, border width (output px)
  webcam_uv: vec4f, // bubble uv -> camera uv: scale xy, offset xy
  look: vec4f,      // cursor style row, click style (0 ring, 1 liquid, 2 pulse, 3 confetti), focus mode, transition kind (0 none)
  trans: vec4f,     // transition amount, unused x3
  lens2: vec4f,     // lens shape from, shape to, morph (0–1), unused
  motion: vec4f,    // cursor travel over the last frame (composed px), cursor lean (radians), unused
  blurs: array<vec4f, ${MAX_BLURS}>,
  clicks: array<vec4f, ${MAX_CLICKS}>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var video: texture_external;
@group(0) @binding(3) var cursor_tex: texture_2d<f32>;
@group(0) @binding(4) var webcam_tex: texture_external;
@group(0) @binding(5) var overlay_tex: texture_2d<f32>;
@group(0) @binding(6) var bg_tex: texture_2d<f32>;
// Webcam matte: person confidence, a blurred copy of the camera, and the mode
// (x: 0 original, 1 blur, 2 remove; y: how far the webcam fills the frame; z: light; w: warmth).
@group(0) @binding(7) var cam_mask: texture_2d<f32>;
@group(0) @binding(8) var cam_blur: texture_2d<f32>;
@group(0) @binding(9) var<uniform> cam_bg: vec4f;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn rounded_rect(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn sd_rect(p: vec2f, rect: vec4f, r: f32) -> f32 {
  let half = rect.zw * 0.5;
  return rounded_rect(p - rect.xy - half, half, min(r, min(half.x, half.y)));
}

// Where a composed-space point falls on the cursor sprite (0–1), with the sprite turned around its tip.
fn cursor_uv(p: vec2f) -> vec2f {
  let a = u.motion.z;
  let d = p - u.cursor.zw;
  let turned = vec2f(cos(a) * d.x + sin(a) * d.y, cos(a) * d.y - sin(a) * d.x);
  return (u.cursor.zw + turned - u.cursor.xy) / u.misc.y;
}

// Three 0–1 random numbers for speck j of a confetti burst: the same every frame and in export.
fn speck_rand(seed: f32, j: i32) -> vec3f {
  var x = u32(seed) * 64u + u32(j);
  x = x * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return vec3f(f32(x & 1023u), f32((x >> 10u) & 1023u), f32((x >> 20u) & 1023u)) / 1023.0;
}

// Where a composed-space point lands on the tilted screen plane, in flat composed coordinates.
fn untilt(p: vec2f) -> vec2f {
  let ay = u.tilt.x;
  let ax = u.tilt.y;
  if (ay == 0.0 && ax == 0.0) { return p; }
  let center = u.box.xy + u.box.zw * 0.5;
  let d = u.tilt.z;
  let rel = p - center;
  let cy = cos(ay); let sy = sin(ay);
  let cx = cos(ax); let sx = sin(ax);
  // Plane basis after rotating around y, then x.
  let right = vec3f(cy, 0.0, -sy);
  let up = vec3f(sy * sx, cx, cy * sx);
  let normal = cross(right, up);
  let eye = vec3f(0.0, 0.0, -d);
  let dir = vec3f(rel, d);
  let t = -dot(eye, normal) / dot(dir, normal);
  let hit = eye + dir * t;
  return center + vec2f(dot(hit, right), dot(hit, up));
}

// Distance from the lens center scaled so the rim is at 1: circle, rounded square or pill.
fn lens_shape(off: vec2f, r: f32, shape: f32) -> f32 {
  if (shape > 1.5) {
    let a = abs(off);
    return length(vec2f(max(a.x - r * 0.75, 0.0), a.y)) / (r * 0.62);
  }
  if (shape > 0.5) {
    let a = abs(off) / (r * 0.92);
    return pow(pow(a.x, 4.0) + pow(a.y, 4.0), 0.25);
  }
  return length(off) / r;
}

fn lens_f(off: vec2f, r: f32) -> f32 {
  return mix(lens_shape(off, r, u.lens2.x), lens_shape(off, r, u.lens2.y), u.lens2.z);
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), s.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), s.x), s.y);
}

fn fbm(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var x = p;
  for (var i = 0; i < 4; i++) {
    v += a * vnoise(x);
    x *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Transition mask at a composed point: x is how much of the frame is left, y a glowing edge, z a scorch.
fn trans_mask(q: vec2f) -> vec3f {
  let kind = u.look.w;
  let amount = u.trans.x;
  let uv = (q - u.box.xy) / max(u.box.z, 1.0);
  if (kind > 3.5 && kind < 4.5) {
    // Burn: a noisy edge sweeps across, glowing as it eats the frame.
    let n = fbm(uv * 4.0) * 0.7 + 0.3 * clamp(uv.x, 0.0, 1.0);
    let edge = amount * 1.02 - 0.02;
    let left = smoothstep(edge - 0.006, edge + 0.006, n);
    let on = left * step(0.001, amount);
    return vec3f(left, (1.0 - smoothstep(0.0, 0.022, n - edge)) * on, (1.0 - smoothstep(0.02, 0.08, n - edge)) * on);
  }
  if (kind > 4.5 && kind < 5.5) {
    // Dissolve: the frame breaks into specks that vanish from left to right.
    let cell = floor(q / max(min(u.frame.x, u.frame.y) * 0.007, 1.0));
    let v = hash(cell) * 0.6 + 0.4 * clamp(uv.x, 0.0, 1.0);
    let left = step(amount * 1.02, v);
    return vec3f(left, (1.0 - smoothstep(0.0, 0.1, v - amount)) * left * step(0.001, amount), 0.0);
  }
  if (kind > 6.5) {
    // Page curl: a fold sweeps from the bottom-right corner; past it the page is gone.
    let s = curl_s(uv);
    let fold = curl_line(amount);
    let left = 1.0 - smoothstep(fold + CURL_R - 0.004, fold + CURL_R, s);
    return vec3f(left, 0.0, 0.0);
  }
  return vec3f(1.0, 0.0, 0.0);
}

const CURL_R = 0.09;
const CURL_DIR = vec2f(0.83, 0.56);

// Position along the curl's direction (0 at the top-left corner, about 1.4 at the bottom-right).
fn curl_s(uv: vec2f) -> f32 {
  return dot(uv, CURL_DIR);
}

// Where the fold line is for a transition amount: off the far corner at 0, past the near one at 1.
fn curl_line(amount: f32) -> f32 {
  return mix(1.45, -CURL_R - 0.02, amount);
}

fn sample_screen(uv: vec2f) -> vec3f {
  let src = mix(u.crop.xy, u.crop.zw, uv);
  var color = textureSampleBaseClampToEdge(video, smp, src).rgb;
  let count = i32(u.extra.x);
  for (var i = 0; i < count; i++) {
    let b = u.blurs[i];
    if (all(src >= b.xy) && all(src <= b.zw)) {
      // Disk blur from samples on a golden-angle spiral: smooth, without the ghosting of a grid.
      var sum = vec3f(0.0);
      let radius = u.extra.y;
      let aspect = vec2f(1.0, u.frame.x / u.frame.y);
      for (var k = 0; k < 48; k++) {
        let r = sqrt((f32(k) + 0.5) / 48.0) * radius;
        let a = f32(k) * 2.39996;
        sum += textureSampleBaseClampToEdge(video, smp, src + vec2f(cos(a), sin(a)) * r * aspect).rgb;
      }
      color = sum / 48.0;
    }
  }
  return color;
}

// The recording at a point, through a zoom-blur or wave transition when one is playing.
fn sample_content(uv0: vec2f) -> vec3f {
  let kind = u.look.w;
  let amount = u.trans.x;
  var uv = uv0;
  if (kind > 6.5) {
    let fold = curl_line(amount);
    let s = curl_s(uv);
    if (s > fold) {
      // The flap: the back of the page, folded over a cylinder, pale like paper seen through.
      let x = clamp((s - fold) / CURL_R, 0.0, 1.0);
      let back = fold + (3.14159 - asin(x)) * CURL_R;
      let src = uv + CURL_DIR * (back - s);
      let paper = sample_screen(clamp(src, vec2f(0.0), vec2f(1.0)));
      let lit = 0.75 + 0.25 * (1.0 - x);
      return mix(paper, vec3f(0.97), 0.72) * lit;
    }
    // Shade the page right before the fold.
    let shade = 1.0 - 0.28 * (1.0 - smoothstep(0.0, CURL_R * 1.4, fold - s)) * step(0.001, amount);
    return sample_screen(clamp(uv, vec2f(0.0), vec2f(1.0))) * shade;
  }
  if (kind > 5.5 && kind < 6.5) {
    uv.x += sin(uv.y * 28.0 + amount * 9.0) * 0.035 * amount;
    uv.y += sin(uv.x * 19.0 + amount * 7.0) * 0.02 * amount;
    let split = vec2f(0.012 * amount, 0.0);
    let r = sample_screen(clamp(uv + split, vec2f(0.0), vec2f(1.0))).r;
    let g = sample_screen(clamp(uv, vec2f(0.0), vec2f(1.0))).g;
    let b = sample_screen(clamp(uv - split, vec2f(0.0), vec2f(1.0))).b;
    return vec3f(r, g, b);
  }
  if (kind > 1.5 && kind < 2.5 && amount > 0.001) {
    let center = vec2f(0.5);
    let grow = 1.0 + amount * 0.35;
    var sum = vec3f(0.0);
    for (var k = 0; k < 12; k++) {
      let s = 1.0 - amount * 0.25 * f32(k) / 11.0;
      sum += sample_screen(clamp(center + (uv - center) / grow * s, vec2f(0.0), vec2f(1.0)));
    }
    return mix(sum / 12.0, vec3f(1.0), amount * amount * 0.55);
  }
  return sample_screen(clamp(uv, vec2f(0.0), vec2f(1.0)));
}

// Light and color temperature of the camera picture (see webcamGrade, which must match).
fn cam_grade(c: vec3f) -> vec3f {
  // A gamma: lifts shadows and midtones and keeps white white, so a dim face brightens without washing out.
  var g = pow(max(c, vec3f(0.0)), vec3f(exp2(-cam_bg.z * 0.9)));
  let warm = cam_bg.w;
  g = g * vec3f(1.0 + 0.14 * warm, 1.0 + 0.03 * warm, 1.0 - 0.14 * warm);
  return clamp(g, vec3f(0.0), vec3f(1.0));
}

// The frame's background at an output point, without zoom: what stands behind a removed webcam background in full frame.
fn cam_backdrop(p: vec2f) -> vec3f {
  let size = u.frame.xy;
  if (u.bg_from.w > 0.5) { return textureSampleLevel(bg_tex, smp, (p / size) * u.bg_image.xy + u.bg_image.zw, 0.0).rgb; }
  let dir = vec2f(cos(u.bg_to.w), sin(u.bg_to.w));
  return mix(u.bg_from.rgb, u.bg_to.rgb, clamp(dot(p / size - 0.5, dir) + 0.5, 0.0, 1.0));
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let size = u.frame.xy;
  let zoom = u.frame.w;
  let out_px = frag.xy * u.frame.z;
  let p = u.camera.xy + out_px / zoom;
  let px = u.frame.z / zoom;

  // Background (not tilted).
  var color: vec3f;
  if (u.bg_from.w > 0.5) {
    color = textureSampleLevel(bg_tex, smp, (p / size) * u.bg_image.xy + u.bg_image.zw, 0.0).rgb;
  } else {
    let dir = vec2f(cos(u.bg_to.w), sin(u.bg_to.w));
    let g = clamp(dot(p / size - 0.5, dir) + 0.5, 0.0, 1.0);
    color = mix(u.bg_from.rgb, u.bg_to.rgb, g);
  }

  let q = untilt(p);
  let radius = u.camera.z;
  let blur = max(min(size.x, size.y) * 0.035, 1.0);
  let frame_kind = u.tilt.w;

  // How much of the frame a transition leaves: fades, turns edge-on, burns or breaks apart.
  let tkind = u.look.w;
  let tamount = u.trans.x;
  var show = 1.0;
  if (tkind > 0.5 && tkind < 1.5) { show = 1.0 - tamount; }
  if (tkind > 2.5 && tkind < 3.5) { show = 1.0 - smoothstep(0.86, 0.99, tamount); }
  let mask = trans_mask(q);
  var shadow_show = show;
  if ((tkind > 3.5 && tkind < 5.5) || tkind > 6.5) { shadow_show = 1.0 - tamount; }

  // Shadow under the frame.
  let ds = sd_rect(q - vec2f(0.0, blur * 0.4), u.box, radius);
  color = mix(color, vec3f(0.0), u.camera.w * 0.55 * shadow_show * (1.0 - smoothstep(-blur, blur * 1.6, ds)));

  // Frame chrome: the window title bar.
  if (frame_kind > 0.5) {
    let dbox = sd_rect(q, u.box, radius);
    var chrome = vec3f(0.93, 0.93, 0.94);
    let bar = u.content.y - u.box.y;
    let dot_r = bar * 0.16;
    for (var i = 0; i < 3; i++) {
      let c = vec2f(u.box.x + bar * 0.62 + f32(i) * dot_r * 3.2, u.box.y + bar * 0.5);
      let dd = length(q - c) - dot_r;
      var dot_color = vec3f(1.0, 0.37, 0.34);
      if (i == 1) { dot_color = vec3f(1.0, 0.74, 0.18); }
      if (i == 2) { dot_color = vec3f(0.16, 0.79, 0.25); }
      chrome = mix(chrome, dot_color, clamp(0.5 - dd / px, 0.0, 1.0));
    }
    color = mix(color, chrome, clamp(0.5 - dbox / px, 0.0, 1.0) * show * mask.x);
  }
  // The recording.
  var content_radius = radius;
  if (frame_kind > 0.5) { content_radius = radius * 0.35; }
  let d = sd_rect(q, u.content, content_radius);
  let cover = clamp(0.5 - d / px, 0.0, 1.0) * show * mask.x;
  if (cover > 0.0) {
    var sp = q;
    // Lens: magnify around its center, bending more toward the rim like thick glass.
    let lens_radius = u.lens.z;
    var rim = 0.0;
    if (lens_radius > 0.5) {
      let off = q - u.lens.xy;
      let f = lens_f(off, lens_radius);
      if (f < 1.0) {
        let bend = 1.0 + 0.35 * pow(f, 3.0);
        sp = u.lens.xy + off / u.lens.w * bend;
        rim = smoothstep(0.82, 1.0, f);
      }
    }
    // Liquid clicks: a ripple that bends the picture as it spreads.
    let clicks = i32(u.misc.z);
    let click_style = u.look.y;
    let liquid = click_style > 0.5 && click_style < 1.5;
    if (liquid) {
      for (var i = 0; i < clicks; i++) {
        let c = u.clicks[i];
        let off = q - c.xy;
        let dist = length(off);
        if (dist > 0.001) {
          let band = c.z * 0.35 + px;
          let wave = exp(-pow((dist - c.z) / band, 2.0));
          sp -= off / dist * wave * c.z * 0.24 * c.w;
        }
      }
    }
    let uv = (sp - u.content.xy) / u.content.zw;
    var screen = sample_content(uv);
    if (lens_radius > 0.5) {
      let f = lens_f(q - u.lens.xy, lens_radius);
      // Glassy rim highlight and a soft edge shadow.
      screen = mix(screen, vec3f(1.0), rim * 0.35);
      let edge = abs(f - 1.0) * lens_radius;
      screen = mix(screen, vec3f(1.0), (1.0 - smoothstep(0.0, px * 2.0, edge)) * 0.7);
      let outside = (f - 1.0) * lens_radius;
      if (outside > 0.0) { screen = mix(screen, vec3f(0.0), (1.0 - smoothstep(0.0, lens_radius * 0.12, outside)) * 0.25); }
    }

    // Spotlight: dim everything but a circle around the cursor.
    if (u.misc.w > 0.0) {
      let r = u.misc.y * 2.4;
      let dc = length(q - u.cursor.zw);
      screen = mix(screen, screen * 0.35, u.misc.w * smoothstep(r * 0.85, r * 1.15, dc));
    }

    // Focus mode: everything but a soft circle around the cursor stays dimmed and slightly blurred.
    let focus = u.look.z;
    if (focus > 0.0) {
      let r = min(u.content.z, u.content.w) * 0.15 + u.misc.y;
      let away = focus * smoothstep(r * 0.7, r * 1.4, length(q - u.cursor.zw));
      if (away > 0.001) {
        let spread = min(u.content.z, u.content.w) * 0.004;
        var sum = screen;
        for (var k = 0; k < 8; k++) {
          let a = f32(k) * 0.785398;
          sum += sample_content((sp + vec2f(cos(a), sin(a)) * spread - u.content.xy) / u.content.zw);
        }
        screen = mix(screen, sum / 9.0 * 0.42, away);
      }
    }

    // Click effects: rings, the light catching a liquid ripple, a swelling disc or a burst of confetti.
    for (var i = 0; i < clicks; i++) {
      let c = u.clicks[i];
      let ring = abs(length(q - c.xy) - c.z);
      if (click_style > 2.5) {
        // Specks fly out, slow down, fall and spin, then fade. w packs the seed with the progress.
        let seed = floor(c.w);
        let t = c.w - seed;
        if (length(q - c.xy) < c.z * 2.2) {
          let fly = 1.0 - pow(1.0 - t, 2.5);
          let fade = 1.0 - smoothstep(0.55, 1.0, t);
          for (var j = 0; j < ${CONFETTI}; j++) {
            let h = speck_rand(seed, j);
            let a = (f32(j) + h.x * 0.8) / ${CONFETTI}.0 * 6.28318;
            let pos = c.xy + (vec2f(cos(a), sin(a) - 0.35) * (0.3 + 0.75 * h.y * h.y) * fly + vec2f(0.0, (0.7 + 0.6 * h.z) * t * t)) * c.z;
            let spin = h.z * 6.28318 + t * (5.0 + 7.0 * h.y) * (h.x - 0.5) * 2.0;
            let d = q - pos;
            let local = vec2f(cos(spin) * d.x + sin(spin) * d.y, cos(spin) * d.y - sin(spin) * d.x);
            let half = c.z * vec2f(0.09, 0.05) * (1.0 - 0.35 * t);
            let dist = rounded_rect(local, half, half.y * 0.4);
            let hue = 0.55 + 0.45 * cos(6.28318 * (h.x * 0.9 + vec3f(0.0, 0.33, 0.67)));
            screen = mix(screen, hue, clamp(0.5 - dist / px, 0.0, 1.0) * fade);
          }
        }
      } else if (click_style > 1.5) {
        // A soft white disc that swells and fades, with a faint dark rim so it reads on white screens.
        let dist = length(q - c.xy);
        let rim = smoothstep(c.z * 0.55, c.z, dist) * (1.0 - smoothstep(c.z, c.z * 1.3, dist));
        screen = mix(screen, vec3f(0.0), rim * c.w * 0.12);
        screen = mix(screen, vec3f(1.0), (1.0 - smoothstep(c.z * 0.5, c.z, dist)) * c.w * 0.5);
      } else if (liquid) {
        // Lit on the inside of the swell, shaded on the outside, so it reads on light and dark screens.
        let band = c.z * 0.35 + px;
        let side = (length(q - c.xy) - c.z) / band;
        let wave = exp(-side * side) * c.w;
        screen = mix(screen, vec3f(1.0), wave * 0.22 * step(side, 0.0));
        screen = mix(screen, vec3f(0.0), wave * 0.14 * step(0.0, side));
      } else {
        // A white ring with a soft dark halo, visible on white screens too.
        let width = max(px * 1.5, c.z * 0.18 + px);
        screen = mix(screen, vec3f(0.0), (1.0 - smoothstep(0.0, width * 2.4, ring)) * c.w * 0.22);
        screen = mix(screen, vec3f(1.0), (1.0 - smoothstep(0.0, width, ring)) * c.w * 0.85);
      }
    }

    // Cursor, from the sprite sheet: one row per style, one column per kind.
    if (u.misc.x > 0.001) {
      let slot = u.webcam2.w;
      let row = u.look.x;
      let travel = u.motion.xy;
      if (dot(travel, travel) > 1.0) {
        // Motion blur: a fading trail of the sprite along the path it just covered, under the sharp cursor.
        var sum = vec4f(0.0);
        for (var k = 1; k <= ${MOTION_SAMPLES}; k++) {
          let back = travel * (f32(k) / ${MOTION_SAMPLES}.0);
          let cuv = cursor_uv(q + back);
          if (all(cuv >= vec2f(0.0)) && all(cuv <= vec2f(1.0))) {
            let c = textureSampleLevel(cursor_tex, smp, vec2f((slot + cuv.x) / ${CURSOR_SLOTS.length}.0, (row + cuv.y) / ${CURSOR_STYLES.length}.0), 0.0);
            let fade = 1.0 - f32(k) / f32(${MOTION_SAMPLES} + 1);
            sum += vec4f(c.rgb * c.a, c.a) * fade;
          }
        }
        sum /= ${MOTION_SAMPLES}.0 * 0.5;
        let trail = min(sum.a, 1.0) * 0.6;
        if (sum.a > 0.001) { screen = mix(screen, sum.rgb / sum.a, trail * u.misc.x); }
      }
      let cuv = cursor_uv(q);
      if (all(cuv >= vec2f(0.0)) && all(cuv <= vec2f(1.0))) {
        let c = textureSampleLevel(cursor_tex, smp, vec2f((slot + cuv.x) / ${CURSOR_SLOTS.length}.0, (row + cuv.y) / ${CURSOR_STYLES.length}.0), 0.0);
        screen = mix(screen, c.rgb, c.a * u.misc.x);
      }
    }

    // A burning edge glows over a scorched band; dissolving specks catch the light.
    if (mask.z > 0.0) { screen = mix(screen, vec3f(0.16, 0.08, 0.03), mask.z * 0.75); }
    if (mask.y > 0.0) {
      var glow = vec3f(1.0, 0.62, 0.2);
      if (tkind > 4.5) { glow = vec3f(0.85); }
      screen = mix(screen, glow, mask.y);
    }
    color = mix(color, screen, cover);
  }

  // Webcam, in output space (unaffected by zoom and tilt): a bubble, the whole frame or a side panel.
  let cam_alpha = u.webcam2.x;
  if (cam_alpha > 0.001) {
    let w = u.webcam;
    let r = u.webcam2.y;
    let dw = sd_rect(out_px, w, r);
    let soft = max(min(w.z, w.w) * 0.08, 4.0);
    let wshadow = 1.0 - smoothstep(-soft, soft * 2.5, sd_rect(out_px - vec2f(0.0, soft * 0.4), w, r));
    // A removed background leaves no bubble to cast a shadow.
    let removed = cam_bg.x > 1.5;
    if (!removed) { color = mix(color, vec3f(0.0), wshadow * u.extra.z * cam_alpha); }
    if (dw < 1.0) {
      // Cover-fit the camera image into the bubble.
      let cam = (out_px - w.xy) / w.zw * u.webcam_uv.xy + u.webcam_uv.zw;
      var cx = cam.x;
      if (u.extra.w > 0.5) { cx = 1.0 - cam.x; }
      let cam_uv = vec2f(cx, cam.y);
      var cam_color = cam_grade(textureSampleBaseClampToEdge(webcam_tex, smp, cam_uv).rgb);
      // Behind the person: the blurred camera, or what lies under the bubble (in full frame, the
      // frame's background rather than the screen).
      if (cam_bg.x > 0.5) {
        let person = smoothstep(0.25, 0.75, textureSampleLevel(cam_mask, smp, cam_uv, 0.0).r);
        var behind = cam_grade(textureSampleLevel(cam_blur, smp, cam_uv, 0.0).rgb);
        if (removed) { behind = mix(color, cam_backdrop(out_px), cam_bg.y); }
        cam_color = mix(behind, cam_color, person);
      }
      // Border along the inside of the edge.
      let border = u.cam_style.w;
      if (border > 0.0) { cam_color = mix(cam_color, u.cam_style.rgb, smoothstep(-border - u.frame.z, -border, dw)); }
      color = mix(color, cam_color, clamp(0.5 - dw / u.frame.z, 0.0, 1.0) * cam_alpha);
    }
  }

  if (u.webcam2.z > 0.5) {
    let o = textureSampleLevel(overlay_tex, smp, out_px / size, 0.0);
    color = mix(color, o.rgb, o.a);
  }

  return vec4f(color, 1.0);
}
`;

function hexColor(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * Draws one cursor (`style` and `kind`) into a CURSOR_BOX-unit square at `unit` pixels per unit:
 * the arrow, pointing hand and text beam in dark or light, a dot, or a picture.
 */
function drawCursor(c: CanvasRenderingContext2D, style: CursorStyle, kind: CursorKind, unit: number) {
  const picture = CURSOR_PICTURES[style];
  if (picture) {
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3 * unit;
    c.shadowOffsetY = 1.2 * unit;
    c.font = `30px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(picture, CURSOR_BOX / 2, CURSOR_BOX / 2 + 1);
    return;
  }
  if (style === "dot") {
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3 * unit;
    c.shadowOffsetY = 1 * unit;
    c.beginPath();
    c.arc(CURSOR_BOX / 2, CURSOR_BOX / 2, kind === "hand" ? 8 : 7, 0, Math.PI * 2);
    c.fillStyle = "rgba(28, 28, 32, 0.82)";
    c.fill();
    c.shadowColor = "transparent";
    c.lineWidth = 2;
    c.strokeStyle = "#ffffff";
    c.stroke();
    return;
  }
  // Classic: dark shape with a white rim. Light: the other way around.
  const rim = style === "light" ? "#111114" : "#ffffff";
  const body = style === "light" ? "#ffffff" : "#111114";
  const outlined = (path: Path2D, inner: Path2D) => {
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 3 * unit;
    c.shadowOffsetY = 1.2 * unit;
    c.fillStyle = rim;
    c.fill(path);
    c.shadowColor = "transparent";
    c.lineJoin = "round";
    c.lineWidth = 1.4;
    c.strokeStyle = rim;
    c.stroke(path);
    c.fillStyle = body;
    c.fill(inner);
  };

  if (kind === "arrow") {
    c.translate(...CURSOR_TIPS.arrow);
    const outer = new Path2D("M0 0 L0 17.5 L4.4 13.4 L7.4 20.2 L10.6 18.8 L7.7 12.2 L13.4 12.2 Z");
    const inner = new Path2D("M1.3 3.1 L1.3 14.4 L4.8 11.2 L7.9 18.2 L9.2 17.6 L6.2 10.9 L10.6 10.9 Z");
    outlined(outer, inner);
  } else if (kind === "hand") {
    c.translate(CURSOR_TIPS.hand[0] - 3.2, CURSOR_TIPS.hand[1]);
    // Pointing hand: index finger up, folded fingers, palm.
    const outer = new Path2D(
      "M1.4 1.2 Q3.2 -0.6 5 1.2 L5 8.5 Q6.6 7.4 8.2 8.6 Q9.8 7.8 11.2 9.2 Q12.8 8.6 14 10.2 L14 16 Q14 21 9.6 22.6 L5.6 22.6 Q3.4 22 2.2 19.6 L-1.6 13.4 Q-2.2 11.6 -0.4 11.2 Q1 11 1.4 12.6 Z",
    );
    const inner = new Path2D(
      "M2.6 2.2 Q3.2 1.4 3.8 2.2 L3.8 11.2 L5 11.2 L5 9.6 Q6.6 9 7 9.9 L7 11.2 L8.2 11.2 L8.2 10.2 Q9.8 9.6 10.2 10.6 L10.2 11.6 L11.4 11.6 L11.4 11.2 Q12.8 10.8 12.8 11.8 L12.8 16 Q12.8 20 9.4 21.4 L5.8 21.4 Q4.2 21 3.2 19 L-0.4 13.2 Q-0.6 12.4 0.2 12.4 L2.6 15.2 Z",
    );
    outlined(outer, inner);
  } else {
    c.translate(...CURSOR_TIPS.text);
    const beam = new Path2D("M-3.5 -9.5 L-1 -9.5 L0 -8.5 L1 -9.5 L3.5 -9.5 L3.5 -8 L1 -8 L1 8 L3.5 8 L3.5 9.5 L1 9.5 L0 8.5 L-1 9.5 L-3.5 9.5 L-3.5 8 L-1 8 L-1 -8 L-3.5 -8 Z");
    c.shadowColor = "rgba(0, 0, 0, 0.35)";
    c.shadowBlur = 2 * unit;
    c.lineWidth = 1.6;
    c.strokeStyle = rim;
    c.lineJoin = "round";
    c.stroke(beam);
    c.shadowColor = "transparent";
    c.fillStyle = body;
    c.fill(beam);
  }
}

/** Every cursor on one sheet: a row per style, with the arrow, hand and text beam side by side. */
function drawCursors(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SPRITE * CURSOR_SLOTS.length;
  canvas.height = SPRITE * CURSOR_STYLES.length;
  const context = canvas.getContext("2d")!;
  const unit = SPRITE / CURSOR_BOX;
  CURSOR_STYLES.forEach(({ id }, row) =>
    CURSOR_SLOTS.forEach((kind, column) => {
      context.save();
      context.translate(column * SPRITE, row * SPRITE);
      context.scale(unit, unit);
      drawCursor(context, id, kind, unit);
      context.restore();
    }),
  );
  return canvas;
}

/** A small picture of a cursor style's arrow, for the style picker. */
export function cursorPreview(style: CursorStyle, size = 40): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = canvas.height = Math.round(size * ratio);
  canvas.style.width = canvas.style.height = `${size}px`;
  const context = canvas.getContext("2d")!;
  const unit = (size * ratio) / CURSOR_BOX;
  context.scale(unit, unit);
  // The arrow sits at the top-left of its box; nudge it toward the middle.
  if (style === "classic" || style === "light") context.translate(8, 6);
  drawCursor(context, style, "arrow", unit);
  return canvas;
}

/** Where the frame and the recording inside it sit in the output. */
export function layout(output: { width: number; height: number }, source: { width: number; height: number }, padding: number, frame: Frame, area: Rect | null = null): Layout {
  const ratio = source.height / source.width;
  // Everything in units of the content width.
  const bar = frame === "window" ? 0.045 : 0;
  const boxHeight = ratio + bar;
  // The screen sits in `area` (fractions of the output), the whole output unless the webcam takes a side.
  const region = area
    ? { x: area.x * output.width, y: area.y * output.height, width: area.width * output.width, height: area.height * output.height }
    : { x: 0, y: 0, width: output.width, height: output.height };
  const pad = padding * Math.min(output.width, output.height);
  const available = { width: Math.max(1, region.width - pad * 2), height: Math.max(1, region.height - pad * 2) };
  const scale = Math.min(available.width, available.height / boxHeight);
  const box = { x: region.x + (region.width - scale) / 2, y: region.y + (region.height - boxHeight * scale) / 2, width: scale, height: boxHeight * scale };
  const content = { x: box.x, y: box.y + bar * scale, width: scale, height: ratio * scale };
  return { content, box };
}

/**
 * Top-left of the visible window for a zoom level and focus. At zoom 1 the window is the whole
 * frame; as it zooms in, the allowed area shrinks smoothly from the frame to the screen itself,
 * so a zoom shows the recording rather than the background around it.
 */
/** The shader's cam_grade as one 256-entry table per channel (red, green, blue), for drawing the camera outside WebGPU. */
export function webcamGrade(light: number, warmth: number): Uint8ClampedArray[] {
  const gamma = 2 ** (-light * 0.9);
  return [1 + 0.14 * warmth, 1 + 0.03 * warmth, 1 - 0.14 * warmth].map((gain) => {
    const table = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) table[i] = Math.round(Math.pow(i / 255, gamma) * gain * 255);
    return table;
  });
}

export function cameraOrigin(output: FrameState["output"], rect: Rect, zoom: number, focus: [number, number]): [number, number] {
  const axis = (frame: number, start: number, length: number, focusAt: number) => {
    const view = frame / zoom;
    const fit = Math.max(1.0001, frame / length);
    const s = Math.min(1, Math.max(0, (zoom - 1) / (fit - 1)));
    const low = start * s;
    const high = frame + (start + length - frame) * s;
    if (high - low <= view) return (low + high) / 2 - view / 2;
    return Math.min(Math.max(focusAt - view / 2, low), high - view);
  };
  return [axis(output.width, rect.x, rect.width, focus[0]), axis(output.height, rect.y, rect.height, focus[1])];
}

type Source = HTMLVideoElement | VideoFrame;

export class Renderer {
  private uniforms = new Float32Array(UNIFORM_VECS * 4);
  private uniformBuffer: GPUBuffer;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private cursorTexture: GPUTexture;
  private overlayTexture: GPUTexture | null = null;
  private backgroundTexture: GPUTexture | null = null;
  private emptyTexture: GPUTexture;
  /** The latest webcam matte (see setWebcamMatte), and whether it has a blurred copy. */
  private matteMask: GPUTexture | null = null;
  private matteBlur: GPUTexture | null = null;
  private matteHasBlur = false;
  private matteBuffer: GPUBuffer;
  private backgroundSize = { width: 1, height: 1 };
  private context: GPUCanvasContext;
  /**
   * Settles when the GPU device goes away (driver reset, sleep, or destroy()); the renderer draws
   * nothing after that and must be created again.
   */
  readonly lost: Promise<GPUDeviceLostInfo>;

  private constructor(private device: GPUDevice, private canvas: HTMLCanvasElement | OffscreenCanvas, format: GPUTextureFormat) {
    this.lost = device.lost;
    this.context = canvas.getContext("webgpu") as GPUCanvasContext;
    this.context.configure({ device, format, alphaMode: "opaque" });
    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.uniformBuffer = device.createBuffer({ size: this.uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    const sprites = drawCursors();
    this.cursorTexture = this.texture(sprites.width, sprites.height);
    device.queue.copyExternalImageToTexture({ source: sprites }, { texture: this.cursorTexture }, [sprites.width, sprites.height]);
    this.emptyTexture = this.texture(1, 1);
    this.matteBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Renderer> {
    if (!navigator.gpu) throw new Error("WebGPU não está disponível neste WebView.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("Nenhum adaptador WebGPU encontrado.");
    const device = await adapter.requestDevice();
    return new Renderer(device, canvas, navigator.gpu.getPreferredCanvasFormat());
  }

  private texture(width: number, height: number) {
    return this.device.createTexture({
      size: [width, height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  /** Uploads the (already blurred) background image; null goes back to gradients. */
  setBackground(image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | null) {
    this.backgroundTexture?.destroy();
    this.backgroundTexture = null;
    if (!image) return;
    this.backgroundTexture = this.texture(image.width, image.height);
    this.backgroundSize = { width: image.width, height: image.height };
    this.device.queue.copyExternalImageToTexture({ source: image }, { texture: this.backgroundTexture }, [image.width, image.height]);
  }

  /** Uploads the text overlay (keys, captions), drawn at output size. */
  setOverlay(canvas: HTMLCanvasElement | OffscreenCanvas) {
    if (!this.overlayTexture || this.overlayTexture.width !== canvas.width || this.overlayTexture.height !== canvas.height) {
      this.overlayTexture?.destroy();
      this.overlayTexture = this.texture(canvas.width, canvas.height);
    }
    this.device.queue.copyExternalImageToTexture({ source: canvas }, { texture: this.overlayTexture }, [canvas.width, canvas.height]);
  }

  /**
   * Uploads the matte of the webcam frame drawn next (person mask and, for blurring, a blurred
   * copy); null forgets it, and the webcam shows as recorded until the next one.
   */
  setWebcamMatte(matte: Matte | null) {
    if (!matte) {
      this.matteMask?.destroy();
      this.matteMask = null;
      return;
    }
    if (!this.matteMask || this.matteMask.width !== matte.width || this.matteMask.height !== matte.height) {
      this.matteMask?.destroy();
      this.matteMask = this.device.createTexture({ size: [matte.width, matte.height], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    }
    this.device.queue.writeTexture({ texture: this.matteMask }, matte.mask, { bytesPerRow: matte.width }, [matte.width, matte.height]);
    this.matteHasBlur = matte.blurred !== null;
    if (matte.blurred) {
      const { width, height } = matte.blurred;
      if (!this.matteBlur || this.matteBlur.width !== width || this.matteBlur.height !== height) {
        this.matteBlur?.destroy();
        this.matteBlur = this.texture(width, height);
      }
      this.device.queue.copyExternalImageToTexture({ source: matte.blurred }, { texture: this.matteBlur }, [width, height]);
    }
  }

  /**
   * Draws one frame from a playing `<video>` (preview) or a decoded `VideoFrame` (export).
   * Returns false while the video has no frame to show yet.
   */
  render(source: Source, state: FrameState, webcam: Source | null = null): boolean {
    const notReady = (media: Source) => media instanceof HTMLVideoElement && (media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !media.videoWidth);
    if (notReady(source)) return false;
    const webcamReady = webcam !== null && state.webcam !== null && !notReady(webcam);

    const { output, video } = state;
    const crop = state.crop ?? { x: 0, y: 0, width: video.width, height: video.height };
    const { content, box } = layout(output, crop, state.background.padding, state.frame, state.area);
    const zoom = Math.max(1, state.zoom);
    const k = content.width / crop.width;
    const toComposed = (x: number, y: number) => [content.x + (x - crop.x) * k, content.y + (y - crop.y) * k] as const;
    const [focusX, focusY] = toComposed(...state.focus);
    const [cameraX, cameraY] = cameraOrigin(output, content, zoom, [focusX, focusY]);

    const u = this.uniforms;
    u.fill(0);
    const vec = (index: number, values: number[]) => u.set(values, index * 4);
    const radius = state.background.radius * (Math.min(output.width, output.height) / 1080);
    vec(0, [output.width, output.height, output.width / this.canvas.width, zoom]);
    vec(1, [cameraX, cameraY, radius, state.background.shadow]);
    vec(2, [content.x, content.y, content.width, content.height]);
    const image = state.background.kind === "image" && this.backgroundTexture ? 1 : 0;
    vec(3, [...hexColor(state.background.from), image]);
    vec(4, [...hexColor(state.background.to), (state.background.angle * Math.PI) / 180]);

    const cursor = state.cursor;
    const cursorBox = cursor ? CURSOR_BOX * cursor.scale * k : 0;
    vec(5, [cursor ? cursor.opacity : 0, cursorBox, 0, state.spotlight]);
    if (cursor) {
      const [x, y] = toComposed(cursor.x, cursor.y);
      const tip = cursorTip(cursor.style, cursor.kind);
      vec(6, [x - (tip[0] / CURSOR_BOX) * cursorBox, y - (tip[1] / CURSOR_BOX) * cursorBox, x, y]);
    }
    vec(7, [crop.x / video.width, crop.y / video.height, (crop.x + crop.width) / video.width, (crop.y + crop.height) / video.height]);
    const tilt = (state.tilt * Math.PI) / 180;
    // "Girar" turns the frame edge-on around its vertical axis, then back from the other side.
    const transition = state.transition;
    const flip = transition?.kind === "flip" ? transition.phase * Math.min(transition.amount, 0.985) * (Math.PI / 2) : 0;
    vec(8, [tilt + flip, -tilt * 0.35, Math.max(output.width, output.height) * 1.6, state.frame === "window" ? 1 : 0]);
    if (state.lens && state.lens.amount > 0.001) {
      const [x, y] = toComposed(state.lens.x, state.lens.y);
      vec(9, [x, y, LENS_RADIUS * k * state.lens.amount, 1 + (state.lens.magnification - 1) * state.lens.amount]);
      vec(19, [...state.lens.shape, 0]);
    }
    // The sprite is smeared over at most a few cursor widths.
    let trail = [0, 0];
    if (state.motion && cursor) {
      const limit = cursorBox * 1.6;
      const [dx, dy] = [state.motion[0] * k, state.motion[1] * k];
      const length = Math.hypot(dx, dy);
      const s = length > limit ? limit / length : 1;
      trail = [dx * s, dy * s];
    }
    vec(20, [...trail, cursor?.angle ?? 0, 0]);
    if (webcamReady) {
      const w = state.webcam!.rect;
      vec(10, [w.x, w.y, w.width, w.height]);
      // Center-crop the camera image to the bubble's shape.
      const cam = webcam instanceof HTMLVideoElement ? { width: webcam.videoWidth, height: webcam.videoHeight } : { width: webcam!.displayWidth, height: webcam!.displayHeight };
      const bubble = w.width / w.height;
      const camera = cam.width / cam.height;
      // Zooming in shows a smaller, centered part of the camera.
      const zoomIn = Math.max(1, state.webcam!.zoom);
      const sx = (camera > bubble ? bubble / camera : 1) / zoomIn;
      const sy = (camera > bubble ? 1 : camera / bubble) / zoomIn;
      vec(16, [sx, sy, (1 - sx) / 2, (1 - sy) / 2]);
      vec(15, [...hexColor(state.webcam!.borderColor), state.webcam!.border]);
    }
    vec(11, [webcamReady ? state.webcam!.opacity : 0, state.webcam?.radius ?? 0, state.overlay && this.overlayTexture ? 1 : 0, cursor ? CURSOR_SLOTS.indexOf(cursor.kind) : 0]);
    if (image) {
      // Cover-fit the image to the output.
      const scale = Math.max(output.width / this.backgroundSize.width, output.height / this.backgroundSize.height);
      const sx = output.width / (this.backgroundSize.width * scale);
      const sy = output.height / (this.backgroundSize.height * scale);
      vec(12, [sx, sy, (1 - sx) / 2, (1 - sy) / 2]);
    }
    vec(13, [box.x, box.y, box.width, box.height]);
    const blurs = state.blurs.slice(0, MAX_BLURS);
    vec(14, [blurs.length, 0.018, (state.webcam?.shadow ?? 0) * 0.6, state.webcam?.mirror ? 1 : 0]);
    blurs.forEach((rect, index) =>
      vec(FIXED_VECS + index, [rect.x / video.width, rect.y / video.height, (rect.x + rect.width) / video.width, (rect.y + rect.height) / video.height]),
    );

    const clickStyle = state.clickStyle;
    const clickLength = CLICK_DURATIONS[clickStyle];
    const clicks = state.clicks.filter((click) => click.age >= 0 && click.age < clickLength).slice(-MAX_CLICKS);
    clicks.forEach((click, index) => {
      const progress = click.age / clickLength;
      const [x, y] = toComposed(click.x, click.y);
      const eased = 1 - Math.pow(1 - progress, 3);
      const unit = k * (cursor?.scale ?? 1) * state.clickSize;
      // Confetti needs its progress and a per-click seed instead of a radius and fade: the burst
      // size goes in z, the seed's whole part plus the progress in w.
      const seed = Math.abs(Math.round(click.x * 7 + click.y * 13 + click.at)) % 997;
      const values =
        clickStyle === "confetti"
          ? [x, y, 70 * unit, seed + Math.min(progress, 0.999)]
          : clickStyle === "pulse"
            ? [x, y, (5 + 23 * eased) * unit, Math.pow(1 - progress, 1.5)]
            : [x, y, (clickStyle === "liquid" ? 8 + 46 * eased : 6 + 26 * eased) * unit, 1 - progress];
      vec(FIXED_VECS + MAX_BLURS + index, values);
    });
    u[22] = clicks.length;
    const styleRow = cursor ? Math.max(0, CURSOR_STYLES.findIndex((candidate) => candidate.id === cursor.style)) : 0;
    const transitionKind = transition ? TRANSITIONS.findIndex((candidate) => candidate.id === transition.kind) + 1 : 0;
    vec(17, [styleRow, CLICK_STYLES.indexOf(clickStyle), state.focusMode * 0.85, transitionKind]);
    vec(18, [transition?.amount ?? 0, 0, 0, 0]);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    // The webcam's background mode, only with a matte to draw it from.
    const camBackground = webcamReady && this.matteMask ? state.webcam!.background : "original";
    const camMode = camBackground === "remove" ? 2 : camBackground === "blur" && this.matteHasBlur ? 1 : 0;
    this.device.queue.writeBuffer(this.matteBuffer, 0, new Float32Array([camMode, state.webcam?.full ?? 0, state.webcam?.light ?? 0, state.webcam?.warmth ?? 0]));
    const screen = this.device.importExternalTexture({ source });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: screen },
        { binding: 3, resource: this.cursorTexture.createView() },
        // Without a webcam the screen stands in; the shader skips it.
        { binding: 4, resource: webcamReady ? this.device.importExternalTexture({ source: webcam! }) : screen },
        { binding: 5, resource: (this.overlayTexture ?? this.emptyTexture).createView() },
        { binding: 6, resource: (this.backgroundTexture ?? this.emptyTexture).createView() },
        { binding: 7, resource: (this.matteMask ?? this.emptyTexture).createView() },
        { binding: 8, resource: (this.matteBlur ?? this.emptyTexture).createView() },
        { binding: 9, resource: { buffer: this.matteBuffer } },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    return true;
  }

  destroy() {
    for (const texture of [this.cursorTexture, this.overlayTexture, this.backgroundTexture, this.emptyTexture, this.matteMask, this.matteBlur]) texture?.destroy();
    this.uniformBuffer.destroy();
    this.matteBuffer.destroy();
    this.device.destroy();
  }
}
