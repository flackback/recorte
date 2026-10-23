/**
 * A laptop rendered in 3D with three.js: aluminum deck with keyboard and trackpad, the lid tilted
 * back, soft studio lighting and a shadow on the ground. The screen is left transparent; the
 * compositor maps the recording into it (`quad`) and draws this picture around it. Pictures are
 * made once per angle and screen shape, then reused.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type LaptopPicture = {
  key: string;
  /** The laptop on a transparent background, with a transparent screen. */
  image: HTMLCanvasElement;
  /** Screen corners in the picture as fractions (0–1): top-left, top-right, bottom-right, bottom-left. */
  quad: [number, number][];
};

/** Glass around the screen, as a fraction of the screen width. */
const BEZEL = { side: 0.022, top: 0.032, bottom: 0.042 };
const LID_THICKNESS = 0.012;
const DECK_THICKNESS = 0.026;
/** How far the lid leans back past upright. */
const LID_LEAN = THREE.MathUtils.degToRad(14);
/** The camera looks down at the laptop from this high. */
const ELEVATION = THREE.MathUtils.degToRad(11);
const FOV = 22;
const CACHE = 4;

const cache = new Map<string, LaptopPicture>();
let stage: { renderer: THREE.WebGLRenderer; environment: THREE.Texture } | null = null;

const ALUMINUM = { color: 0xc2c5cb, metalness: 0.95, roughness: 0.3 };

function getStage() {
  if (!stage) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    stage = { renderer, environment };
  }
  return stage;
}

/** A rounded rectangle as a 2D shape, centered on the origin. */
function roundedRect(width: number, height: number, radius: number) {
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

/**
 * Black glass with a faint diagonal sheen. Unlit on purpose: a flat glossy panel under one light is
 * either all highlight or none, depending on the angle.
 */
function glassTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const sheen = context.createLinearGradient(0, 0, 256, 256);
  sheen.addColorStop(0, "#1f1f23");
  sheen.addColorStop(0.45, "#09090b");
  sheen.addColorStop(1, "#050506");
  context.fillStyle = sheen;
  context.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Builds the laptop; returns it with the four screen corners (world space, after `update`). */
function buildLaptop(ratio: number) {
  const laptop = new THREE.Group();
  const lidWidth = 1 + BEZEL.side * 2;
  const lidHeight = ratio + BEZEL.top + BEZEL.bottom;
  const deckDepth = lidHeight * 0.97;
  const aluminum = new THREE.MeshStandardMaterial(ALUMINUM);

  // Deck.
  const deck = new THREE.Mesh(new RoundedBoxGeometry(lidWidth, DECK_THICKNESS, deckDepth, 4, 0.011), aluminum);
  deck.position.y = DECK_THICKNESS / 2;
  deck.castShadow = true;
  laptop.add(deck);
  const top = DECK_THICKNESS + 0.0004;

  // Keyboard well and keys.
  const keyboardWidth = lidWidth * 0.84;
  const keyboardDepth = deckDepth * 0.42;
  const keyboardZ = -deckDepth / 2 + 0.05 + keyboardDepth / 2;
  const well = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(keyboardWidth + 0.012, keyboardDepth + 0.012, 0.008)), new THREE.MeshStandardMaterial({ color: 0x232427, metalness: 0.4, roughness: 0.6 }));
  well.rotation.x = -Math.PI / 2;
  well.position.set(0, top, keyboardZ);
  laptop.add(well);
  const rows = [14, 14, 14, 13, 12, 11];
  const keyGap = 0.0045;
  const rowDepth = (keyboardDepth - keyGap * (rows.length - 1)) / rows.length;
  const keyShape = new RoundedBoxGeometry(1, 0.004, 1, 2, 0.0015);
  const keys = new THREE.InstancedMesh(keyShape, new THREE.MeshStandardMaterial({ color: 0x1c1d21, metalness: 0.1, roughness: 0.62 }), rows.reduce((sum, count) => sum + count, 0));
  const matrix = new THREE.Matrix4();
  let instance = 0;
  let rowStart = keyboardZ - keyboardDepth / 2;
  rows.forEach((count, row) => {
    // The top row is the short function-key row; the bottom row has a wide space bar.
    const depth = row === 0 ? rowDepth * 0.6 : rowDepth;
    const z = rowStart + depth / 2;
    rowStart += depth + keyGap;
    const widths = Array.from({ length: count }, (_, index) => (row === rows.length - 1 && index === Math.floor(count / 2) ? 5 : row > 0 && (index === 0 || index === count - 1) ? 1.5 : 1));
    const unit = (keyboardWidth - keyGap * (count - 1)) / widths.reduce((sum, width) => sum + width, 0);
    let x = -keyboardWidth / 2;
    for (const width of widths) {
      const keyWidth = width * unit;
      matrix.compose(new THREE.Vector3(x + keyWidth / 2, top + 0.002, z), new THREE.Quaternion(), new THREE.Vector3(keyWidth, 1, depth));
      keys.setMatrixAt(instance++, matrix);
      x += keyWidth + keyGap;
    }
  });
  keys.count = instance;
  laptop.add(keys);

  // Trackpad.
  const padWidth = lidWidth * 0.4;
  const padDepth = deckDepth * 0.3;
  const pad = new THREE.Mesh(new THREE.ShapeGeometry(roundedRect(padWidth, padDepth, 0.012)), new THREE.MeshStandardMaterial({ color: 0xc4c7cc, metalness: 0.75, roughness: 0.28 }));
  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, top, deckDepth / 2 - 0.035 - padDepth / 2);
  laptop.add(pad);

  // Lid, hinged at the back of the deck, leaning back.
  const hinge = new THREE.Group();
  hinge.position.set(0, DECK_THICKNESS, -deckDepth / 2 + 0.006);
  hinge.rotation.x = -LID_LEAN;
  laptop.add(hinge);
  const lid = new THREE.Mesh(new RoundedBoxGeometry(lidWidth, lidHeight, LID_THICKNESS, 4, 0.0055), aluminum);
  lid.position.set(0, lidHeight / 2, 0);
  lid.castShadow = true;
  hinge.add(lid);
  // Black glass over the front; the screen is drawn over it.
  const front = LID_THICKNESS / 2 + 0.0004;
  const screenCenterY = BEZEL.bottom + ratio / 2;
  const glassShape = new THREE.ShapeGeometry(roundedRect(lidWidth - 0.003, lidHeight - 0.003, 0.01));
  // Shape UVs are positions; stretch them to 0–1 so the sheen spans the panel.
  const uv = glassShape.getAttribute("uv");
  for (let index = 0; index < uv.count; index++) uv.setXY(index, uv.getX(index) / lidWidth + 0.5, uv.getY(index) / lidHeight + 0.5);
  const glass = new THREE.Mesh(glassShape, new THREE.MeshBasicMaterial({ map: glassTexture() }));
  glass.position.set(0, lidHeight / 2, front);
  hinge.add(glass);
  // The screen itself: written fully transparent, so the recording shows through.
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, ratio), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.NoBlending }));
  screen.position.set(0, screenCenterY, front + 0.0002);
  hinge.add(screen);
  // Camera.
  const camera = new THREE.Mesh(new THREE.CircleGeometry(0.0045, 24), new THREE.MeshBasicMaterial({ color: 0x141821 }));
  camera.position.set(0, lidHeight - BEZEL.top / 2, front + 0.0003);
  hinge.add(camera);

  const screenCorners = [
    new THREE.Vector3(-0.5, screenCenterY + ratio / 2, front),
    new THREE.Vector3(0.5, screenCenterY + ratio / 2, front),
    new THREE.Vector3(0.5, screenCenterY - ratio / 2, front),
    new THREE.Vector3(-0.5, screenCenterY - ratio / 2, front),
  ];
  // Points that bound the whole laptop, for framing.
  const bounds = [
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => new THREE.Vector3((sx * lidWidth) / 2, 0, (sz * deckDepth) / 2))),
    ...[-1, 1].map((sx) => new THREE.Vector3((sx * lidWidth) / 2, lidHeight, front)),
  ];
  return { laptop, hinge, deckDepth, lidHeight, screenCorners, bounds };
}

/**
 * The laptop seen at `yaw` degrees (turned left or right), for a screen `ratio` (height / width) tall,
 * about `width` pixels wide.
 */
export function laptopPicture(yaw: number, ratio: number, width: number): LaptopPicture {
  const key = `${yaw.toFixed(1)}|${ratio.toFixed(4)}|${Math.round(width)}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const { renderer, environment } = getStage();
  const scene = new THREE.Scene();
  scene.environment = environment;
  const { laptop, hinge, lidHeight, deckDepth, screenCorners, bounds } = buildLaptop(ratio);
  laptop.rotation.y = THREE.MathUtils.degToRad(yaw * 1.6);
  scene.add(laptop);

  // Light from above and in front, casting a soft shadow on an invisible floor.
  // Mostly overhead, so the shadow falls under and just behind the laptop.
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.25, 4, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 14;
  sun.shadow.blurSamples = 16;
  sun.shadow.bias = -0.0005;
  const extent = 1.2;
  Object.assign(sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 0.1, far: 8 });
  scene.add(sun, new THREE.AmbientLight(0xffffff, 0.25));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.ShadowMaterial({ opacity: 0.22 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Camera in front, a little above, looking between the screen and the keyboard.
  const target = new THREE.Vector3(0, lidHeight * 0.42, -deckDepth * 0.12);
  const distance = 3.4;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 20);
  camera.position.set(0, target.y + Math.sin(ELEVATION) * distance, target.z + Math.cos(ELEVATION) * distance);
  camera.lookAt(target);
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  // Frame the laptop: project its bounds on a square view, then render only that region.
  const project = (point: THREE.Vector3, object: THREE.Object3D) => point.clone().applyMatrix4(object.matrixWorld).project(camera);
  const outline = [...bounds.slice(0, 4).map((point) => project(point, laptop)), ...bounds.slice(4).map((point) => project(point, hinge))];
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  // Room for the shadow below and around.
  const margin = { side: 0.06, top: 0.04, bottom: 0.1 };
  const left = Math.min(...xs) - margin.side;
  const right = Math.max(...xs) + margin.side;
  const bottom = Math.min(...ys) - margin.bottom;
  const topEdge = Math.max(...ys) + margin.top;
  const full = Math.round((width / (right - left)) * 2);
  const region = {
    x: Math.round(((left + 1) / 2) * full),
    y: Math.round(((1 - topEdge) / 2) * full),
    width: Math.round(((right - left) / 2) * full),
    height: Math.round(((topEdge - bottom) / 2) * full),
  };
  camera.setViewOffset(full, full, region.x, region.y, region.width, region.height);
  camera.aspect = region.width / region.height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(1);
  renderer.setSize(region.width, region.height, false);
  renderer.render(scene, camera);

  // A copy, since the next picture reuses the same WebGL canvas.
  const image = document.createElement("canvas");
  image.width = region.width;
  image.height = region.height;
  image.getContext("2d")!.drawImage(renderer.domElement, 0, 0);
  const quad = screenCorners.map((corner) => {
    const point = project(corner, hinge);
    return [point.x * 0.5 + 0.5, 0.5 - point.y * 0.5] as [number, number];
  });

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        (material as THREE.MeshBasicMaterial).map?.dispose();
        material.dispose();
      }
    }
  });
  sun.shadow.map?.dispose();

  const picture = { key, image, quad };
  cache.set(key, picture);
  while (cache.size > CACHE) cache.delete(cache.keys().next().value!);
  return picture;
}

/**
 * The 3×3 matrix (row-major) that maps the unit square — (0,0), (1,0), (1,1), (0,1) — onto a
 * quadrilateral given in the same corner order.
 */
export function squareToQuad(quad: [number, number][]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

/** Inverse of a row-major 3×3 matrix. */
export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((value) => value / det);
}

/** Applies a row-major 3×3 projective matrix to a point. */
export function project2(m: number[], x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}
