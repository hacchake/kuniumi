// 線形 HDR → 表示用 sRGB 8bit。Three.js のトーンマップ（AgX / ACES Filmic）と同じ式を CPU で行う。
// 静止画の仕上げ（かすみ・光のにじみを足した後）に使う。

// GLSL の mat3(列0, 列1, 列2) と同じ並び。M * v
const mul = (m, r, g, b) => [
  m[0][0] * r + m[1][0] * g + m[2][0] * b,
  m[0][1] * r + m[1][1] * g + m[2][1] * b,
  m[0][2] * r + m[1][2] * g + m[2][2] * b,
];

const SRGB_TO_REC2020 = [[0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.088], [0.0433, 0.0113, 0.8956]];
const REC2020_TO_SRGB = [[1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]];
const AGX_INSET = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const AGX_OUTSET = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const AGX_MIN = -12.47393, AGX_MAX = 4.026069;
const ACES_IN = [[0.59719, 0.076, 0.0284], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
const ACES_OUT = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];

const agxContrast = (x) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

function agx(r, g, b) {
  let c = mul(SRGB_TO_REC2020, r, g, b);
  c = mul(AGX_INSET, c[0], c[1], c[2]);
  c = c.map((v) => {
    const t = (Math.log2(Math.max(v, 1e-10)) - AGX_MIN) / (AGX_MAX - AGX_MIN);
    return agxContrast(Math.min(1, Math.max(0, t)));
  });
  c = mul(AGX_OUTSET, c[0], c[1], c[2]).map((v) => Math.pow(Math.max(0, v), 2.2));
  return mul(REC2020_TO_SRGB, c[0], c[1], c[2]).map((v) => Math.min(1, Math.max(0, v)));
}

const rrt = (v) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
function aces(r, g, b) {
  let c = mul(ACES_IN, r / 0.6, g / 0.6, b / 0.6).map(rrt);
  return mul(ACES_OUT, c[0], c[1], c[2]).map((v) => Math.min(1, Math.max(0, v)));
}

const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// hdr: Float32Array RGBA（線形）。戻り値: ImageData 用の Uint8ClampedArray
export function toneMapToRGBA8(hdr, width, height, { mode = 'agx', exposure = 1 } = {}) {
  const out = new Uint8ClampedArray(width * height * 4);
  const fn = mode === 'aces' ? aces : agx;
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    const c = fn(hdr[o] * exposure, hdr[o + 1] * exposure, hdr[o + 2] * exposure);
    // 8bit への量子化で空のグラデーションに段が出ないよう、わずかにディザを掛ける
    const d = (((i * 1103515245 + 12345) >>> 16) & 255) / 255 - 0.5;
    out[o] = toSrgb(c[0]) * 255 + d;
    out[o + 1] = toSrgb(c[1]) * 255 + d;
    out[o + 2] = toSrgb(c[2]) * 255 + d;
    out[o + 3] = 255;
  }
  return out;
}

// Radiance HDR（.hdr / RGBE）に書き出す。合成ソフトや Blender の環境光に使える
export function encodeRadianceHDR(hdr, width, height) {
  const header = `#?RADIANCE\n# KUNIUMI\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y ${height} +X ${width}\n`;
  const head = new TextEncoder().encode(header);
  const body = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    const r = hdr[i * 4], g = hdr[i * 4 + 1], b = hdr[i * 4 + 2];
    const m = Math.max(r, g, b);
    if (m < 1e-32) continue;
    const e = Math.floor(Math.log2(m)) + 1; // m = f × 2^e（0.5 ≤ f < 1）
    const s = 256 / Math.pow(2, e);
    body[i * 4] = Math.min(255, r * s);
    body[i * 4 + 1] = Math.min(255, g * s);
    body[i * 4 + 2] = Math.min(255, b * s);
    body[i * 4 + 3] = e + 128;
  }
  return new Blob([head, body], { type: 'image/vnd.radiance' });
}
