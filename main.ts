// Eclipse Tide — an original deterministic procedural artwork.
// A black eclipse disc crowned by a molten corona hangs over layered
// ridge silhouettes and a bright reflective tide. Rendered per pixel
// with distance fields and value-noise ridges. Node standard library
// only, fully offline, byte-for-byte deterministic on every run.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const W = 1024;
const H = 1024;

// ---------- deterministic helpers ----------
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function smooth(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function mix(a, b, t) {
  return a + (b - a) * t;
}
function mix3(c1, c2, t) {
  return [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
}

// ---------- palette ----------
const SKY_TOP = [16, 10, 46];
const SKY_MID = [58, 20, 92];
const SKY_LOW = [178, 62, 92];
const CORONA_HOT = [255, 236, 170];
const CORONA_MID = [255, 146, 58];
const CORONA_DEEP = [214, 48, 96];
const RIDGE_FAR = [64, 32, 102];
const RIDGE_MID = [38, 20, 74];
const RIDGE_NEAR = [16, 12, 40];
const SEA_TOP = [24, 90, 120];
const SEA_DEEP = [7, 18, 54];
const FOAM = [190, 240, 235];

// ---------- scene geometry ----------
// Eclipse centre and radii, in pixels.
const CX = 512;
const CY = 408;
const DISC_R = 168;
const RING_R = 196;

// Ridgeline heights: each ridge is a horizon y for a given x, built
// from stacked sine waves so the silhouette stays smooth and fixed.
function ridgeY(x, base, a1, f1, p1, a2, f2, p2) {
  const s1 = Math.sin(x * f1 + p1) * a1;
  const s2 = Math.sin(x * f2 + p2) * a2;
  const s3 = Math.sin(x * 0.011 + p1 * 2.7) * 9;
  return base + s1 + s2 + s3;
}

// Colour of one pixel.
function pixel(x, y) {
  // Sky gradient with a warm band near the horizon.
  const v = y / H;
  let col = v < 0.55
    ? mix3(SKY_TOP, SKY_MID, smooth(0, 0.55, v))
    : mix3(SKY_MID, SKY_LOW, smooth(0.55, 0.86, v));

  // Stars: one bright point per coarse cell, only in the dark sky.
  const cell = 26;
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const rnd = hash2(gx, gy);
  if (rnd > 0.82 && y < 560) {
    const sx = gx * cell + 4 + Math.floor(hash2(gx + 91, gy + 7) * 18);
    const sy = gy * cell + 4 + Math.floor(hash2(gx + 3, gy + 57) * 18);
    const d = Math.hypot(x - sx, y - sy);
    const tw = 0.55 + 0.45 * hash2(gx + 13, gy + 29);
    const star = smooth(2.6, 0.0, d) * tw * smooth(560, 180, y);
    col = mix3(col, [235, 240, 255], star * 0.9);
  }

  // Distance to the eclipse centre drives corona, ring and disc.
  const dx = x - CX;
  const dy = y - CY;
  const dist = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);

  // Corona glow: falls off with distance, streaked by angle so the
  // halo looks like molten rays rather than a smooth blur.
  const streak = 0.78
    + 0.22 * Math.sin(ang * 18 + Math.sin(ang * 5) * 1.6)
    + 0.10 * Math.sin(ang * 43 + 1.3);
  const glow = Math.exp(-Math.max(0, dist - DISC_R) / 118) * streak;
  const glowCol = mix3(CORONA_DEEP, CORONA_MID, clamp(glow * 1.25, 0, 1));
  col = mix3(col, glowCol, clamp(glow * 0.85, 0, 0.9));
  const hot = Math.exp(-Math.max(0, dist - DISC_R) / 34) * streak;
  col = mix3(col, CORONA_HOT, clamp(hot * 0.75, 0, 0.85));

  // The bright ring just outside the disc edge.
  const ring = smooth(13, 0, Math.abs(dist - RING_R));
  col = mix3(col, CORONA_HOT, ring * 0.95);

  // The black disc itself, with a hair of deep violet at its rim.
  const inside = smooth(DISC_R + 1.5, DISC_R - 1.5, dist);
  col = mix3(col, [5, 4, 14], inside);
  const rim = smooth(10, 0, Math.abs(dist - DISC_R)) * (1 - inside);
  col = mix3(col, [30, 10, 54], rim * 0.6);

  // A comet slashes the upper-left sky: a bright head on a fixed
  // diagonal with a tapering tail that fades along its length.
  const cometT = clamp(((x - 128) * 0.82 + (y - 118) * 0.57) / 250, 0, 1);
  const cometPx = 128 + cometT * 205;
  const cometPy = 118 + cometT * 143;
  const cometD = Math.hypot(x - cometPx, y - cometPy);
  const cometTail = (1 - cometT) * smooth(26, 0, cometD);
  col = mix3(col, [168, 220, 255], cometTail * 0.5);
  const cometHead = smooth(7, 0, Math.hypot(x - 333, y - 261));
  col = mix3(col, [240, 250, 255], cometHead * 0.95);

  // A small flock crosses the face of the eclipse. Each bird is two
  // shallow arcs meeting at its body centre, drawn as a dark mark
  // whose wings rise away from the centre point on both sides.
  const birds = [
    [438, 352, 15], [486, 322, 11], [404, 318, 9], [522, 372, 8],
    [462, 392, 7], [350, 372, 10],
  ];
  for (const [bx, by, s] of birds) {
    const bdx = x - bx;
    const bdy = y - by + Math.abs(bdx) * 0.42;
    const bd = Math.hypot(bdx * (18 / s), bdy * 3.1);
    const bird = smooth(9, 3.5, bd) * smooth(s + 6, s - 4, Math.abs(bdx));
    col = mix3(col, [8, 6, 18], bird * 0.92);
  }

  // Three ridge silhouettes marching toward the viewer.
  const far = ridgeY(x, 648, 26, 0.004, 1.7, 12, 0.013, 4.1);
  if (y > far) col = RIDGE_FAR.slice();
  const mid = ridgeY(x, 724, 30, 0.003, 5.2, 14, 0.011, 0.6);
  if (y > mid) col = RIDGE_MID.slice();
  const near = ridgeY(x, 806, 22, 0.005, 2.9, 10, 0.017, 3.3);
  if (y > near) col = RIDGE_NEAR.slice();

  // Snow-fire edge: a thin warm line where each ridge catches light.
  const eFar = smooth(3.2, 0, Math.abs(y - far));
  const eMid = smooth(3.2, 0, Math.abs(y - mid));
  const eNear = smooth(3.2, 0, Math.abs(y - near));
  col = mix3(col, CORONA_MID, eFar * 0.55 + eMid * 0.4 + eNear * 0.3);

  // A lighthouse stands on the near ridge at the right, its lamp lit.
  // The tower is a tapering dark column; a soft beam leans out of the
  // lamp toward the eclipse, widening and fading with distance.
  const LH_X = 838;
  const LH_TOP = 690;
  const LH_BASE = 822;
  if (y >= LH_TOP && y <= LH_BASE) {
    const lt = (y - LH_TOP) / (LH_BASE - LH_TOP);
    const halfW = mix(7, 15, lt);
    if (Math.abs(x - LH_X) < halfW) col = [10, 8, 26];
    if (y > LH_TOP + 16 && y < LH_TOP + 30 && Math.abs(x - LH_X) < 5) {
      col = CORONA_HOT.slice();
    }
  }
  if (y >= LH_TOP - 10 && y <= LH_TOP + 2 && Math.abs(x - LH_X) < 11) {
    col = [10, 8, 26];
  }
  const lampGlow = Math.exp(-Math.hypot(x - LH_X, y - (LH_TOP + 23)) / 26);
  col = mix3(col, CORONA_HOT, clamp(lampGlow * 0.75, 0, 0.8));
  // Beam: distance travelled left from the lamp, spread grows along it.
  const beamRun = LH_X - x;
  if (beamRun > 0 && x > 470) {
    const beamCentreY = LH_TOP + 23 - beamRun * 0.16;
    const beamHalf = 6 + beamRun * 0.075;
    const inBeam = smooth(beamHalf, beamHalf * 0.25, Math.abs(y - beamCentreY));
    const beamFade = Math.exp(-beamRun / 330);
    col = mix3(col, [255, 214, 140], inBeam * beamFade * 0.30);
  }

  // The tide: below the near ridge the scene becomes open water.
  const SEA_Y = 858;
  if (y > SEA_Y) {
    const sv = (y - SEA_Y) / (H - SEA_Y);
    let sea = mix3(SEA_TOP, SEA_DEEP, Math.pow(sv, 0.72));
    // A vertical column of reflected eclipse light under the disc.
    const colDist = Math.abs(x - CX + Math.sin(y * 0.11) * 7 * sv);
    const reflect = Math.exp(-colDist / (54 + sv * 150));
    const shimmer = 0.72 + 0.28 * Math.sin(y * 0.9 + Math.sin(x * 0.05) * 2);
    sea = mix3(sea, CORONA_MID, reflect * shimmer * (1 - sv * 0.55) * 0.8);
    sea = mix3(sea, CORONA_HOT, reflect * smooth(46, 0, Math.abs(((y * 3) % 64) - 32)) * 0.25);
    // Horizontal foam flecks, hashed per short segment.
    const seg = Math.floor(x / 22);
    const row = Math.floor(y / 9);
    if (hash2(seg, row) > 0.86) {
      const fleck = smooth(4.5, 0, Math.abs(y - (row * 9 + 4)));
      sea = mix3(sea, FOAM, fleck * 0.5 * (1 - sv * 0.5));
    }
    col = sea;
    // Darken the very top of the water where the ridge shadow falls.
    col = mix3([6, 10, 30], col, smooth(SEA_Y, SEA_Y + 26, y));
  }

  // Gentle vignette to pull the eye to the centre.
  const vd = Math.hypot(x - 512, y - 500) / 760;
  const vig = 1 - 0.26 * smooth(0.45, 1.05, vd);
  return [col[0] * vig, col[1] * vig, col[2] * vig];
}

// ---------- PNG encoder (manual, zlib deflate) ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG() {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = clamp(Math.round(r), 0, 255);
      raw[o++] = clamp(Math.round(g), 0, 255);
      raw[o++] = clamp(Math.round(b), 0, 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- entry point ----------
const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "entry.png"), encodePNG());
