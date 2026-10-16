// 地表の衛星写真（JPEG の data URL、行 0 = 北）を読む。メインスレッドでもワーカーでも使える。

// 画素（RGBA 8bit）として：{ data: Uint8ClampedArray, width, height }
// maxSize を渡すと、長い辺がそれ以下になるよう縮めて読む（木の配置など、細かさの要らない用途）
export async function decodePhoto(url, maxSize = 0) {
  const bmp = await createImageBitmap(await (await fetch(url)).blob(), { imageOrientation: 'none' });
  const k = maxSize > 0 ? Math.min(1, maxSize / Math.max(bmp.width, bmp.height)) : 1;
  const c = new OffscreenCanvas(Math.max(2, Math.round(bmp.width * k)), Math.max(2, Math.round(bmp.height * k)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}

// 写真の (u, v)（0..1、v = 0 が北）の色を、線形の RGB（0..1）で out へ。双一次補間
const lin = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function photoAt(photo, u, v, out) {
  const { data, width: W, height: H } = photo;
  const x = Math.min(W - 1, Math.max(0, u * W - 0.5)), y = Math.min(H - 1, Math.max(0, v * H - 0.5));
  const x0 = Math.min(W - 2, Math.floor(x)), y0 = Math.min(H - 2, Math.floor(y)), fx = x - x0, fy = y - y0;
  const a = (y0 * W + x0) * 4, b = a + 4, c = a + W * 4, d = c + 4;
  for (let ch = 0; ch < 3; ch++) {
    out[ch] = (lin[data[a + ch]] * (1 - fx) + lin[data[b + ch]] * fx) * (1 - fy) + (lin[data[c + ch]] * (1 - fx) + lin[data[d + ch]] * fx) * fy;
  }
  return out;
}

// 写真から見た「森らしさ」（0..1）：暗い緑。畑・草地（明るい緑）、街（灰色）、水（青）、裸地は低い
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const tmp = new Float32Array(3);
export function photoForest(photo, u, v) {
  const [r, g, b] = photoAt(photo, u, v, tmp);
  const green = (g - r) / (g + r + 1e-4);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return smooth(0.02, 0.14, green) * (1 - smooth(0.07, 0.16, lum)) * (1 - smooth(0.9, 1.1, b / (g + 1e-4)));
}

// 写真の明るさを地表の色（反射率）に合わせる倍率。衛星写真は大気の明るさも含むので少し下げる
export const PHOTO_ALBEDO = 0.85;
