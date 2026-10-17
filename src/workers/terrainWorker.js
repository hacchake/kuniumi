// 地形の重い計算（ノイズ生成・ハイトマップ解釈・地表色の焼き込み）をメインスレッドから外す
import { generateNoiseField, resampleImage } from '../core/heightfield.js';
import { computeTerrainColors } from '../core/terrainColor.js';
import { decodePng } from '../core/png16.js';
import { applyErosion } from '../core/erosion.js';
import { applySculpt, roundPeaks } from '../core/sculpt.js';

let field = null;
let wear = null; // 侵食で盛った(+)・削った(−)量
let fieldRes = 0;
let fieldKey = null;
const decoded = new Map(); // heightmap.id → 解釈済み画像

self.onmessage = async (e) => {
  const { id, key, terrain, color } = e.data;
  try {
    let fieldChanged = false;
    if (key !== fieldKey) {
      ({ field, wear } = await buildField(terrain));
      if (terrain.mode !== 'heightmap') roundPeaks(field, terrain.resolution, terrain.size, terrain.noise.round ?? 0); // 山の丸み
      applySculpt(field, terrain.resolution, terrain); // 手彫りの跡を重ねる
      fieldRes = terrain.resolution;
      fieldKey = key;
      fieldChanged = true;
    }
    // 地表の色（テクスチャ）は書き出しのときだけ焼く。リアルタイム表示は GPU が塗る
    const msg = { id, key, res: fieldRes };
    const transfer = [];
    if (color) {
      const colors = computeTerrainColors(field, fieldRes, color, wear);
      msg.colors = colors.data;
      msg.texSize = colors.size;
      transfer.push(colors.data.buffer);
    }
    if (fieldChanged) {
      msg.field = field.slice();
      transfer.push(msg.field.buffer);
      if (wear) {
        msg.wear = wear.slice();
        transfer.push(msg.wear.buffer);
      }
    }
    self.postMessage(msg, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

async function buildField(t) {
  if (t.mode === 'heightmap' && t.heightmap?.png) {
    let img = decoded.get(t.heightmap.id);
    if (!img) {
      const buf = await (await fetch(t.heightmap.png)).arrayBuffer();
      img = await decodePng(buf);
      if (!img) throw new Error('このPNG形式は読めません');
      decoded.clear();
      decoded.set(t.heightmap.id, img);
    }
    return { field: resampleImage(img.data, img.width, img.height, t.resolution), wear: null };
  }
  const f = generateNoiseField(t.noise, t.resolution);
  return applyErosion(f, t.resolution, t.noise.erosion ?? 0, t.noise.seed);
}

