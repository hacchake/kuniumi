// 地形の重い計算（ノイズ生成・ハイトマップ解釈・地表色の焼き込み）をメインスレッドから外す
import { generateNoiseField, resampleImage } from '../core/heightfield.js';
import { computeTerrainColors } from '../core/terrainColor.js';
import { decodePng } from '../core/png16.js';
import { applyErosion } from '../core/erosion.js';

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
      fieldRes = terrain.resolution;
      fieldKey = key;
      fieldChanged = true;
    }
    const colors = computeTerrainColors(field, fieldRes, color, wear);
    const msg = { id, key, res: fieldRes, colors: colors.data, texSize: colors.size };
    const transfer = [colors.data.buffer];
    if (fieldChanged) {
      msg.field = field.slice();
      transfer.push(msg.field.buffer);
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

