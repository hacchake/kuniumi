import { valueNoise } from './terrainColor.js';
import { mulberry32 } from './noise.js';

// 植生（森と草地）の規則。Three.js 非依存。
// 「どこに木が生えるか」を 1 か所で決め、地表の色（遠くの森は暗い緑）と、一枚絵での木の配置の両方に使う。

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function defaultVegetation() {
  return {
    trees: 0.5, // 木の量（0 = なし）
    treeHeight: 16, // 木の高さの目安 (m)
    conifer: 0.5, // 針葉樹の割合（標高が高いほど増える）
    grass: 0.6, // 足元の草の量（一枚絵で、カメラが地面に近いときだけ）
    seed: 77,
  };
}

// ctx: { heightScale, baseHeight, waterLevel, waterEnabled, palette, vegetation }
export function createVegetationRules(ctx) {
  const veg = { ...defaultVegetation(), ...(ctx.vegetation ?? {}) };
  const { heightScale, baseHeight, waterEnabled, palette } = ctx;
  const sea = waterEnabled ? ctx.waterLevel : baseHeight - 1;
  const top = baseHeight + heightScale;
  const shoreBand = Math.max(4, heightScale * 0.012);
  const rs = palette.rockSlope;
  const sl = palette.snowLine;
  const seed = veg.seed | 0;

  // 植物が育てる土地か（0..1）：急斜面・雪線近く・水辺・土砂のたまり場は苦手
  const habitat = (H, slope, wv) => {
    const alt = (H - sea) / Math.max(1, top - sea);
    return (
      (1 - smooth(rs * 0.45, rs * 0.85, slope)) *
      (1 - smooth(sl - 0.28, sl - 0.1, alt)) *
      smooth(shoreBand * 1.2, shoreBand * 3, H - sea) *
      (1 - smooth(0.006, 0.03, wv))
    );
  };
  // 森の広がり：大きな群落と、その中の林間のすき間
  const clump = (x, z) => smooth(0.4, 0.62, valueNoise(x / 220, z / 220, seed) * 0.7 + valueNoise(x / 55, z / 55, seed + 1) * 0.3);

  return {
    veg,
    // 木の密度（0..1）。地表の色づけにも使う
    forest(H, slope, wv, x, z) {
      if (!(veg.trees > 0)) return 0;
      return habitat(H, slope, wv) * clump(x, z) * Math.min(1, veg.trees * 1.6);
    },
    // 草の密度（0..1）
    grass(H, slope, wv, x, z) {
      if (!(veg.grass > 0)) return 0;
      const open = 0.35 + 0.65 * smooth(0.3, 0.7, valueNoise(x / 7, z / 7, seed + 5));
      return habitat(H, slope, wv) * open * Math.min(1, veg.grass * 1.4);
    },
    // 針葉樹になる確率：標高が高いほど増える
    coniferChance(H) {
      const alt = (H - sea) / Math.max(1, top - sea);
      return Math.min(1, Math.max(0, veg.conifer + (alt - 0.35) * 1.2));
    },
  };
}

// 一枚絵用に木と草を並べる。
// sample(x, z): { h: 高さ(m), slope, wv } を返す関数（粗い格子から引く・安い）
// heightAt(x, z): 足元の正確な高さ（細かい地形と同じ）
// view: { position, target, fov, aspect }
// 戻り値: { conifer: Float32Array(n*5), broadleaf: …, grass: … }  各要素 [x, y, z, 大きさ, 向き(rad)] と色ゆらぎ
export function placeVegetation(rules, size, sample, heightAt, view, { maxTrees = 160_000, maxGrass = 60_000 } = {}) {
  const veg = rules.veg;
  const rand = mulberry32(veg.seed + 4242);
  const C = view.position;
  const fwd = norm([view.target[0] - C[0], view.target[1] - C[1], view.target[2] - C[2]]);
  const halfV = (view.fov / 2) * (Math.PI / 180);
  const halfH = Math.atan(Math.tan(halfV) * view.aspect);
  const flatF = norm([fwd[0], 0, fwd[2]]);
  // 水平方向の視野（左右の余白込み）。真下を見ているときは全方位
  const lookDown = Math.abs(fwd[1]) > 0.85;
  const inView = (x, z, r) => {
    if (lookDown) return true;
    const dx = x - C[0], dz = z - C[2];
    const d = Math.hypot(dx, dz);
    if (d < r * 2 + 30) return true;
    const cos = (dx * flatF[0] + dz * flatF[2]) / d;
    return cos > Math.cos(Math.min(Math.PI, halfH * 1.25 + r / d));
  };

  const out = { conifer: [], broadleaf: [], grass: [] };

  // ---- 木：見えている範囲に、格子＋ゆらぎで候補を置き、森の密度で間引く ----
  if (veg.trees > 0) {
    const cell = Math.max(5, veg.treeHeight * 0.55);
    const reach = size * 1.5; // 地形の外まで見える遠景も含める
    const n = Math.ceil(reach / cell);
    let count = 0;
    for (let j = -n; j <= n && count < maxTrees; j++) {
      for (let i = -n; i <= n && count < maxTrees; i++) {
        const x = (i + rand()) * cell, z = (j + rand()) * cell;
        const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
        if (Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
        if (!inView(x, z, veg.treeHeight)) continue;
        const s = sample(x, z);
        if (r1 > rules.forest(s.h, s.slope, s.wv, x, z)) continue;
        const y = heightAt(x, z);
        const h = veg.treeHeight * (0.55 + r2 * 0.75);
        const kind = r3 < rules.coniferChance(y) ? 'conifer' : 'broadleaf';
        out[kind].push(x, y - h * 0.03, z, h, r4 * Math.PI * 2);
        count++;
      }
    }
  }

  // ---- 草：カメラの足元近く（画面で見分けられる距離）だけ ----
  if (veg.grass > 0) {
    const ground = heightAt(C[0], C[2]);
    const above = C[1] - ground;
    const radius = Math.min(260, Math.max(0, 200 - above * 1.2)); // 高い所から見下ろすときは置かない
    if (radius > 5) {
      const cell = 0.9;
      const n = Math.ceil(radius / cell);
      let count = 0;
      for (let j = -n; j <= n && count < maxGrass; j++) {
        for (let i = -n; i <= n && count < maxGrass; i++) {
          const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
          const r1 = rand(), r2 = rand(), r3 = rand();
          const d = Math.hypot(x - C[0], z - C[2]);
          if (d > radius || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
          if (!inView(x, z, 2)) continue;
          const s = sample(x, z);
          // 遠いほど間引く（画面上の密度をそろえる）
          if (r1 > rules.grass(s.h, s.slope, s.wv, x, z) * (1 - smooth(radius * 0.6, radius, d) * 0.7)) continue;
          out.grass.push(x, heightAt(x, z) - 0.02, z, 0.35 + r2 * 0.45, r3 * Math.PI * 2);
          count++;
        }
      }
    }
  }
  return {
    conifer: new Float32Array(out.conifer),
    broadleaf: new Float32Array(out.broadleaf),
    grass: new Float32Array(out.grass),
  };
}

function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}
