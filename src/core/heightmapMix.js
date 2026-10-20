import { generateNoiseField, resampleImage, sampleField } from './heightfield.js';
import { applyErosion, erosionParams } from './erosion.js';

// ハイトマップにノイズを重ねる・雨で削る（terrain.heightmapMix）。
// リアルタイム表示（terrainWorker）と一枚絵（lodWorker → terrainSurface）が同じ画像から同じ結果を得るよう、
// 解釈済みの画像 { data(0..1), width, height } を受け取り、同じ大きさの画像を返す。
//   mode: 'none' | 'add'（足す） | 'multiply'（掛ける） | 'max'（高い方） | 'min'（低い方）
//   amount: 重ねる強さ 0..1
//   erode: true なら重ねたあとに雨で削る（強さ・性質は「地形の性格」の侵食の設定）
// 戻り値: { img, wear }（wear: 侵食で盛った(+)・削った(−)量、513 格子。削らなければ null）
const NR = 513;

export function heightmapMixActive(terrain) {
  const m = terrain.heightmapMix;
  if (!m) return false;
  return ((m.mode ?? 'none') !== 'none' && m.amount > 0) || (m.erode && (terrain.noise?.erosion ?? 0) > 0);
}

export function mixHeightmap(img, terrain) {
  if (!heightmapMixActive(terrain)) return { img, wear: null };
  const m = terrain.heightmapMix;
  const { width: W, height: H } = img;
  const data = img.data.slice();
  const mode = m.mode ?? 'none';
  if (mode !== 'none' && m.amount > 0) {
    // ノイズは外周を沈めない（ハイトマップの形をそのまま残す）
    const n = generateNoiseField({ ...terrain.noise, falloff: 0 }, NR);
    const a = Math.min(1, Math.max(0, m.amount));
    for (let j = 0; j < H; j++) {
      const v = H > 1 ? j / (H - 1) : 0;
      for (let i = 0; i < W; i++) {
        const k = j * W + i, h = data[k];
        const q = sampleField(n, NR, W > 1 ? i / (W - 1) : 0, v);
        let r = h;
        if (mode === 'add') r = h + (q - 0.5) * a;
        else if (mode === 'multiply') r = h * (1 - a + a * q * 2 * 0.75); // 平均でおよそ元の高さの 3/4
        else if (mode === 'max') r = h + (Math.max(h, q) - h) * a;
        else if (mode === 'min') r = h + (Math.min(h, q) - h) * a;
        data[k] = Math.min(1, Math.max(0, r));
      }
    }
  }
  let wear = null;
  if (m.erode && (terrain.noise?.erosion ?? 0) > 0) {
    const sq = resampleImage(data, W, H, NR);
    wear = applyErosion(sq, NR, terrain.noise.erosion, terrain.noise.seed ?? 0, erosionParams(terrain.noise)).wear;
    if (wear) {
      for (let j = 0; j < H; j++) {
        const v = H > 1 ? j / (H - 1) : 0;
        for (let i = 0; i < W; i++) data[j * W + i] = Math.max(0, data[j * W + i] + sampleField(wear, NR, W > 1 ? i / (W - 1) : 0, v));
      }
    }
  }
  return { img: { ...img, data }, wear };
}

export { NR as MIX_WEAR_RES };
