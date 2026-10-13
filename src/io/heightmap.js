import { encodeGray16, decodePng } from '../core/png16.js';
import { fieldRange } from '../core/heightfield.js';
import { RESOLUTIONS } from '../core/schema.js';
import { blobToDataURL } from './files.js';

// ハイトマップ（16bit グレースケール PNG）の書き出し・読み込み。
// 画素値 0..65535 → 標高 baseHeight .. baseHeight+heightScale。画像の上が北。
// 実寸は PNG の tEXt "kuniumi" に JSON で入れておき、読み込み時に復元する。

export async function exportHeightmap(field, res, terrain, waterLevel) {
  const info = {
    software: 'KUNIUMI',
    size: terrain.size,
    heightScale: terrain.heightScale,
    baseHeight: terrain.baseHeight,
    waterLevel,
    note: 'pixel 0..65535 = baseHeight..baseHeight+heightScale (m). top = north (-Z / Blender +Y)',
  };
  return encodeGray16(field, res, res, { kuniumi: JSON.stringify(info), Software: 'KUNIUMI' });
}

// 戻り値: { heightmap, resolution, info }。info は tEXt から読めた実寸（なければ null）
export async function importHeightmap(file) {
  const buf = await file.arrayBuffer();
  let img = await decodePng(buf).catch(() => null);
  let info = null;
  if (img?.text?.kuniumi) {
    try {
      info = JSON.parse(img.text.kuniumi);
    } catch {
      info = null;
    }
  }
  if (!img) img = await decodeWithBrowser(file); // JPEG・8bit・インターレース等（精度は 8bit）

  // 中身をそのまま 16bit PNG に統一してシーンに埋め込む（ワーカー側が確実に読めるように）
  const blob = await encodeGray16(img.data, img.width, img.height);
  const png = await blobToDataURL(blob);
  const resolution = RESOLUTIONS.reduce((a, b) => (Math.abs(b - img.width) < Math.abs(a - img.width) ? b : a));
  const { min, max } = fieldRange(img.data);
  return {
    heightmap: {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      png,
      width: img.width,
      height: img.height,
      bitDepth: img.bitDepth ?? 8,
    },
    resolution,
    info,
    range: { min, max },
  };
}

async function decodeWithBrowser(file) {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Float32Array(bmp.width * bmp.height);
  for (let k = 0; k < data.length; k++) data[k] = px[k * 4] / 255;
  return { width: bmp.width, height: bmp.height, data, bitDepth: 8 };
}

// 高さ場（0..1）を 16bit PNG の dataURL にしてシーンへ埋め込む（glb 読み込みで使う）
export async function fieldToHeightmap(field, res, name) {
  const blob = await encodeGray16(field, res, res);
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    png: await blobToDataURL(blob),
    width: res,
    height: res,
    bitDepth: 16,
  };
}
