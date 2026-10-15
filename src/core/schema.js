// シーン設定（JSON）の定義。
// 描画処理はすべてこのデータを読んで絵を作る。ここには Three.js を持ち込まない。
// リアルタイム表示・高画質書き出し・外部ソフト連携が、同じデータを共有するための「正本」。

import { normalizeObject } from './objects.js';

export const FORMAT = 'kuniumi.scene';
export const VERSION = 1;

// 地形メッシュの解像度（頂点数/辺）。2^n+1 にしておくとハイトマップの慣例と合う
export const RESOLUTIONS = [129, 257, 513, 1025];

export function createDefaultScene() {
  return {
    format: FORMAT,
    version: VERSION,
    meta: {
      name: '名もなき星',
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    },
    terrain: {
      mode: 'noise', // 'noise' | 'heightmap'
      size: 8000, // 一辺の長さ (m)
      resolution: 257,
      heightScale: 1200, // 起伏の高さ (m)。正規化した高さ 0..1 に掛ける
      baseHeight: -250, // 正規化高さ 0 の標高 (m)
      noise: {
        seed: 1207,
        frequency: 2.2, // 地形全体に入る大きな山の数の目安
        octaves: 8,
        persistence: 0.48, // 細部の粗さ
        lacunarity: 2.0,
        ridged: 0.45, // 尾根の鋭さ（0=なだらか、1=稜線）
        warp: 0.35, // 地形のうねり（ドメインワープ）
        valley: 1.35, // 谷の平らさ（高さの指数）
        falloff: 0.55, // 外周を沈める度合い（島・大陸づくり）
        erosion: 0.5, // 雨による侵食（谷筋と扇状地）
      },
      heightmap: null, // { id, name, png(dataURL 16bit推奨), width, height }
      palette: {
        shore: '#c9b48a',
        low: '#4d6b2f',
        high: '#7a6a48',
        rock: '#5e554c',
        snow: '#f2f4f7',
        snowLine: 0.72, // 水面〜最高点のうち、雪が乗り始める割合
        rockSlope: 0.95, // 岩肌が出始める傾斜（勾配 tan）
      },
    },
    water: {
      enabled: true,
      level: 0, // 水面の標高 (m)
      color: '#0f3a4a',
      distortion: 3.7,
      waveScale: 1.0,
    },
    sun: {
      elevation: 16, // 地平線からの高度 (度)
      azimuth: 118, // 北(-Z) から東(+X) 回りの方位 (度)
      intensity: 1.0,
    },
    atmosphere: {
      turbidity: 3.5, // 大気の濁り
      rayleigh: 2.2, // 空の青さ（レイリー散乱）
      mieCoefficient: 0.006,
      mieDirectionalG: 0.8,
      haze: 0.22, // 遠景のかすみ
      exposure: 0.12, // 露出（太陽・空は物理的な明るさなので小さめ）
      ambient: 1.0, // 空からの環境光の強さ（1 = 物理的に正しい明るさ）
      clouds: 0.3, // 雲の量（0 = 快晴）
      cloudDensity: 0.5, // 雲の厚さ
      cloudScale: 0.0002, // 雲の模様の細かさ（大きいほど細かい）
      cloudElevation: 0.5, // 雲の高さ（見かけ）
    },
    camera: {
      position: [-5600, 2100, 6400],
      target: [0, 150, 0],
      fov: 50,
    },
    // 球・立方体などの物体（core/objects.js）。追加項目なので version 1 のまま、無ければ空
    objects: [],
    render: {
      // 将来の高画質一枚絵モード用。第1段階では書き出し時のカメラ縦横比に使う
      still: {
        width: 1920,
        height: 1080,
        samples: 64, // 1 画素あたりの光線の数（多いほどなめらか・時間がかかる。ノイズ除去があれば 32〜128 で十分）
        terrainDetail: 1025, // 静止画用に作り直す地形の頂点数/辺（1025 / 2049）
        denoise: true, // AI ノイズ除去（Intel Open Image Denoise）
        tone: 'agx', // 'agx'（映画調）| 'aces'
        exposure: 1, // リアルタイムの露出に掛ける補正
        bloom: 0.04, // 明るい所の光のにじみ
      },
    },
  };
}

// 読み込んだ JSON を既定値で補い、型を整える。古い版や欠けたキーにも耐える
export function normalizeScene(input) {
  const base = createDefaultScene();
  if (!input || typeof input !== 'object') return base;
  if (input.format && input.format !== FORMAT) {
    throw new Error(`KUNIUMI のシーンではありません (format: ${input.format})`);
  }
  if ((input.version ?? 1) > VERSION) {
    console.warn('新しい版のシーンです。読めない項目は無視します');
  }
  // 雲の項目が無いのは「太陽と空の明るさを物理的にそろえる前」のシーン。当時の露出は明るさの基準が違うので換算する
  const legacyExposure = input.atmosphere && input.atmosphere.clouds === undefined && typeof input.atmosphere.exposure === 'number';
  const merged = deepMerge(base, input);
  if (legacyExposure) merged.atmosphere.exposure = Math.round(input.atmosphere.exposure * 0.25 * 1000) / 1000;
  merged.format = FORMAT;
  merged.version = VERSION;
  const t = merged.terrain;
  if (!RESOLUTIONS.includes(t.resolution)) {
    t.resolution = RESOLUTIONS.reduce((a, b) => (Math.abs(b - t.resolution) < Math.abs(a - t.resolution) ? b : a));
  }
  if (t.mode === 'heightmap' && !t.heightmap?.png) t.mode = 'noise';
  merged.objects = (Array.isArray(merged.objects) ? merged.objects : []).map(normalizeObject);
  return merged;
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base;
  if (base === null || typeof base !== 'object') return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (k in base && base[k] !== null && typeof base[k] === 'object' && !Array.isArray(base[k]) && v && typeof v === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export { deepMerge };

// "terrain.noise.seed" のようなパスでの読み書き（書き込みは不変更新）
export function getIn(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setIn(obj, path, value) {
  const [head, ...rest] = path.split('.');
  const copy = Array.isArray(obj) ? obj.slice() : { ...obj };
  copy[head] = rest.length ? setIn(obj?.[head] ?? {}, rest.join('.'), value) : value;
  return copy;
}

// 変更パスの一覧に、指定した接頭辞の変更が含まれるか
export function touches(changed, prefix) {
  return changed.some((p) => p === '*' || p === prefix || p.startsWith(prefix + '.') || prefix.startsWith(p + '.'));
}
