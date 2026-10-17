import { createNoiseSampler, generateNoiseFieldWithRange, sampleField, edgeFade } from './heightfield.js';
import { applyErosion } from './erosion.js';
import { applySculpt, roundPeaks } from './sculpt.js';
import { detailHeight, shoreFade } from './terrainDetail.js';

// 地形の「任意の地点の高さ」を返す部品。一枚絵の細かい地形と、木・草の配置が使う。
//   heightAt(x, z, spacing): 標高 (m)。spacing (m) より細かい起伏は描かない
//   wearAt(x, z): 侵食で盛った(+)/削った(−)量
//   coarse(x, z): { h, slope, wv } 粗い格子から引く安い近似（木の候補の間引き用）
//
// ノイズ地形：ノイズを直接計算し、設定より細かいオクターブまで足せる（近景ほど細かい）
// ハイトマップ地形：画像を滑らかに補間（Catmull-Rom）し、画素より細かい所には小さな起伏を足す
const BASE = 513; // ノイズ地形の侵食と正規化の基準格子（リアルタイム表示の侵食と同じ）

// heightmapImage: { data: Float32Array(0..1), width, height }（ハイトマップ地形のとき）
// sea: 水面の高さ（水が無ければ null）。海面の近くでは細部の起伏を弱める
// ref: { field, res }（リアルタイム表示の高さ場。侵食・山の丸み・手彫りまで入ったもの）。渡すと大きな形はそれに合わせ、
// ここでは格子より細かい起伏だけを足す（一枚絵の地面がリアルタイム表示とずれて、カメラが浮いたり埋まったりしないように）
export function createTerrainSurface(terrain, heightmapImage = null, sea = null, ref = null) {
  const { size, heightScale, baseHeight } = terrain;
  if (terrain.mode === 'heightmap' && heightmapImage) return heightmapSurface(terrain, heightmapImage, sea);
  if (ref?.field && ref.res > 1) return refSurface(terrain, ref);

  const noise = terrain.noise;
  const base = generateNoiseFieldWithRange(noise, BASE);
  const { wear } = applyErosion(base.field, BASE, noise.erosion ?? 0, noise.seed);
  const raw = createNoiseSampler(noise, { refNyquist: (BASE - 1) / 3, extraOctaves: 6 });
  const span = base.max - base.min || 1;

  const heightAt = (x, z, spacing) => {
    const u = x / size + 0.5, v = z / size + 0.5;
    const nyq = size / spacing / 3;
    let h = (raw(u, v, nyq) - base.min) / span;
    h = Math.pow(Math.max(0, h), noise.valley) * edgeFade(u, v, noise.falloff);
    if (wear) h += sampleField(wear, BASE, u, v);
    return baseHeight + Math.max(0, h) * heightScale + deltaAt(u, v) * heightScale;
  };
  const wearAt = (x, z) => (wear ? sampleField(wear, BASE, x / size + 0.5, z / size + 0.5) : 0);
  const gh0 = (u, v) => sampleField(base.field, BASE, u, v) + (wear ? sampleField(wear, BASE, u, v) : 0);
  const deltaAt = editDelta(terrain, gh0, noise.round ?? 0);
  const gh = (u, v) => gh0(u, v) + deltaAt(u, v);
  return { heightAt, wearAt, coarse: coarseFrom(gh, BASE, terrain, wearAt) };
}

function refSurface(terrain, ref) {
  const own = createTerrainSurface(terrain); // 細かい起伏を取り出すための、ノイズから作り直した地形
  const { size, heightScale, baseHeight } = terrain;
  const { field, res } = ref;
  const cell = size / (res - 1);
  const refH = (x, z) => baseHeight + sampleField(field, res, x / size + 0.5, z / size + 0.5) * heightScale;
  const heightAt = (x, z, spacing) => {
    // 格子 1.5 マスより細かい起伏だけ（ノイズの細かい段の差）を、リアルタイム表示の地形に足す
    const fine = spacing < cell * 1.5 ? own.heightAt(x, z, spacing) - own.heightAt(x, z, cell * 1.5) : 0;
    return refH(x, z) + fine;
  };
  const gh = (u, v) => sampleField(field, res, u, v);
  return { heightAt, wearAt: own.wearAt, coarse: coarseFrom(gh, res, terrain, own.wearAt) };
}

function heightmapSurface(terrain, img, sea) {
  const { size, heightScale, baseHeight } = terrain;
  const { data, width: W, height: H } = img;
  const px = (i, j) => data[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))];
  const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  // 画像を Catmull-Rom で補間（0..1）。画像の上 = 北 = v=0
  const bicubic = (u, v) => {
    const x = Math.min(1, Math.max(0, u)) * (W - 1), y = Math.min(1, Math.max(0, v)) * (H - 1);
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const row = (jj) => cr(px(i - 1, jj), px(i, jj), px(i + 1, jj), px(i + 2, jj), fx);
    return cr(row(j - 1), row(j), row(j + 1), row(j + 2), fy);
  };
  // 画素より細かい所の小さな起伏（リアルタイム表示と同じ式。近景の平らな多角形を和らげる）
  const pixelM = size / Math.max(1, Math.max(W, H) - 1);
  const amount = terrain.detail ?? 1;
  const detailAt = (x, z, spacing) => detailHeight(x, z, pixelM, spacing, amount);
  const deltaAt = editDelta(terrain, bicubic, 0);
  const heightAt = (x, z, spacing) => {
    const u = x / size + 0.5, v = z / size + 0.5;
    const h = baseHeight + (bicubic(u, v) + deltaAt(u, v)) * heightScale;
    return h + detailAt(x, z, spacing) * shoreFade(h, sea);
  };
  const wearAt = () => 0;
  return { heightAt, wearAt, coarse: coarseFrom((u, v) => bicubic(u, v) + deltaAt(u, v), Math.max(W, H), terrain, wearAt) };
}

// 山の丸みと手彫り（terrain.sculpt）で変わった量（0..1 の高さの差）を、1025 格子に求めて補間する。
// リアルタイム表示（terrainWorker）と同じ式を同じ世界座標に当てるので、同じ所が同じように変わる
const EDIT_RES = 1025;
function editDelta(terrain, gh, round) {
  if (!(round > 0) && !terrain.sculpt?.length) return () => 0;
  const N = EDIT_RES;
  const orig = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) orig[j * N + i] = gh(i / (N - 1), j / (N - 1));
  const mod = orig.slice();
  if (round > 0) roundPeaks(mod, N, terrain.size, round);
  applySculpt(mod, N, terrain);
  for (let k = 0; k < mod.length; k++) mod[k] -= orig[k];
  return (u, v) => sampleField(mod, N, u, v);
}

// 粗い格子の近似：高さ・勾配・侵食
function coarseFrom(gh, res, { size, heightScale, baseHeight }, wearAt) {
  const cell = size / (res - 1);
  const e = 1 / (res - 1);
  return (x, z) => {
    const u = x / size + 0.5, v = z / size + 0.5;
    const gx = ((gh(u + e, v) - gh(u - e, v)) * heightScale) / (2 * cell);
    const gz = ((gh(u, v + e) - gh(u, v - e)) * heightScale) / (2 * cell);
    return { h: baseHeight + gh(u, v) * heightScale, slope: Math.hypot(gx, gz), wv: wearAt(x, z) };
  };
}
