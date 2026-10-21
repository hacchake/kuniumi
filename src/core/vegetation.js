import { valueNoise } from './terrainColor.js';
import { photoForest } from '../io/photo.js';
import { mulberry32, hash2 } from './noise.js';
import { lakeLevelAt } from './lakes.js';

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
    litter: 0.6, // 木の下の落ち葉・落ち針の量（一枚絵で、カメラが地面に近いときだけ）
    tropical: 0, // 熱帯の割合（一枚絵で、広葉樹のうちヤシになる割合。下草も大きな葉の熱帯の株が混ざる）
    seed: 77,
    paint: [], // 手で植えた・伐った跡：[{ x, z, r, v }]（v = 1 植える、-1 伐る）。リアルタイム表示と一枚絵の両方に効く
  };
}

// 水際（砂浜・草の生えない帯）の高さの幅 (m)。起伏の大きさに比例させるが、
// 海底を含む実際の地形（起伏の大半が海の深さ）では広くなりすぎるので、海面から上の高さで決め、30 m までにする。
// 地球から取り込んだ地形（realWorld）では、平野が砂浜にならないよう 5 m までにする
export function shoreBandOf(heightScale, baseHeight, sea, realWorld = false) {
  const b = Math.max(4, Math.min(heightScale * 0.012, (baseHeight + heightScale - sea) * 0.012, 30));
  // 実際の地形では海面すれすれの平野（水田・干拓地）が多いので、浜の帯はごく細く（0.4 m。砂色は海抜 1 m ほどまで）
  return realWorld ? Math.min(b, 0.4) : b;
}

// ctx: { heightScale, baseHeight, waterLevel, waterEnabled, palette, vegetation }
export function createVegetationRules(ctx) {
  const veg = { ...defaultVegetation(), ...(ctx.vegetation ?? {}) };
  const { heightScale, baseHeight, waterEnabled, palette } = ctx;
  const sea = waterEnabled ? ctx.waterLevel : baseHeight - 1;
  // その地点のいちばん近い水面：海と、窪地の湖（ctx.lakes）の高い方。湖の中と岸辺にも木を立てない
  const lakes = ctx.lakes ?? null;
  const wAt = lakes ? (x, z) => Math.max(sea, lakeLevelAt(lakes, ctx.size ?? 1, x, z)) : () => sea;
  const top = baseHeight + heightScale;
  const shoreBand = shoreBandOf(heightScale, baseHeight, sea, !!ctx.realWorld);
  const rs = palette.rockSlope;
  const sl = palette.snowLine;
  const seed = veg.seed | 0;

  // 植物が育てる土地か（0..1）：急斜面・雪線近く・水辺・土砂のたまり場は苦手
  // nearShore: 草のように水際のすぐ近くまで育つもの
  const habitat = (H, slope, wv, nearShore = false, w = sea) => {
    const alt = (H - sea) / Math.max(1, top - sea);
    return (
      // 草（nearShore）は岩が出始める傾斜の近くまで生える（山の草地は 35° ほどの斜面にも続く）。木はそれより手前まで
      (nearShore ? 1 - smooth(rs * 0.7, rs * 1.15, slope) : 1 - smooth(rs * 0.45, rs * 0.85, slope)) *
      (1 - smooth(sl - 0.28, sl - 0.1, alt)) *
      (nearShore ? smooth(shoreBand * 0.1 + 0.1, shoreBand * 0.6 + 0.4, H - w) : smooth(shoreBand * 1.2, shoreBand * 3, H - w)) *
      (1 - smooth(0.006, 0.03, wv))
    );
  };
  // 森の広がり：大きな群落と、その中の林間のすき間。
  // 衛星写真（ctx.photo、範囲の一辺 ctx.size）があれば、写真で森に見える所に木を立てる（街や畑には立てない）
  const photo = ctx.photo ?? null;
  const psize = ctx.size ?? 1;
  const clump = photo
    ? (x, z) => photoForest(photo, x / psize + 0.5, z / psize + 0.5) * (0.75 + 0.25 * valueNoise(x / 64, z / 64, seed + 1))
    : (x, z) => smooth(0.4, 0.62, valueNoise(x / 256, z / 256, seed) * 0.7 + valueNoise(x / 64, z / 64, seed + 1) * 0.3);

  const paint = paintIndex(veg.paint);
  return {
    veg,
    // 木の密度（0..1）。地表の色づけにも使う。手で植えた・伐った所（veg.paint）はそれを重ねる
    forest(H, slope, wv, x, z) {
      const hab = habitat(H, slope, wv, false, wAt(x, z));
      let d = veg.trees > 0 ? hab * clump(x, z) * Math.min(1, veg.trees * 1.6) : 0;
      if (paint) {
        for (const p of paint(x, z)) {
          const dx = x - p.x, dz = z - p.z, r2 = p.r * p.r, d2 = dx * dx + dz * dz;
          if (d2 >= r2) continue;
          const t = 1 - d2 / r2, w = t * t * (3 - 2 * t);
          // 植える：育つ土地（急斜面・雪・水辺でない）ほど濃い森へ。伐る：0 へ
          d = p.v > 0 ? d + (Math.max(d, 0.15 + 0.8 * hab) - d) * w : d * (1 - w);
        }
      }
      return d;
    },
    // 草の密度（0..1）
    grass(H, slope, wv, x, z) {
      if (!(veg.grass > 0)) return 0;
      const open = 0.35 + 0.65 * smooth(0.3, 0.7, valueNoise(x / 8, z / 8, seed + 5));
      // 森の中は日陰で草が減る（下草はシダなどに）
      const shade = 1 - 0.65 * smooth(0.3, 0.8, this.forest(H, slope, wv, x, z));
      return habitat(H, slope, wv, true, wAt(x, z)) * open * shade * Math.min(1, veg.grass * 1.4);
    },
    // シダ（森の下草）の密度（0..1）：木の多い所の、湿った緩い地面に
    fern(H, slope, wv, x, z) {
      if (!(veg.grass > 0)) return 0;
      const f = this.forest(H, slope, wv, x, z);
      const n = smooth(0.3, 0.6, valueNoise(x / 10, z / 10, seed + 17));
      return smooth(0.15, 0.5, f) * n * (1 - smooth(rs * 0.5, rs * 0.9, slope));
    },
    // 葦（ヨシ）の密度（0..1）：水際の緩い所に群れて生える（浅瀬にも少し入る）
    reeds(H, slope, x, z) {
      if ((!waterEnabled && !lakes) || !(veg.grass > 0)) return 0;
      const above = H - wAt(x, z);
      if (above < -0.7 || above > shoreBand * 1.6 + 1) return 0;
      const band = smooth(-0.7, -0.15, above) * (1 - smooth(shoreBand * 0.5 + 0.3, shoreBand * 1.6 + 1, above));
      const flat = 1 - smooth(rs * 0.2, rs * 0.45, slope);
      const clumps = smooth(0.38, 0.62, valueNoise(x / 14, z / 14, seed + 13) * 0.75 + valueNoise(x / 3, z / 3, seed + 14) * 0.25);
      return band * flat * clumps * Math.min(1, veg.grass * 1.4);
    },
    // 岩・石の密度（0..1）：斜面ほど多く、岩肌の手前・水際（石の河原・磯）にも。急な崖そのものと雪の上には置かない
    rocks(H, slope, wv, x, z) {
      const above = H - wAt(x, z);
      if (above < -0.8) return 0; // 水の底には置かない（浅瀬の石は置く）
      const n = valueNoise(x / 40, z / 40, seed + 9);
      // 岩は転がり落ちて止まる所に：緩い斜面（斜面の裾・谷筋・水際）に多く、急な斜面には置かない
      const steep = 1 - smooth(0.25, 0.5, slope);
      if (steep <= 0) return 0;
      let d = 0.03 + 0.3 * smooth(0.08, 0.25, slope) * steep;
      d += 0.55 * (1 - smooth(shoreBand * 0.3, shoreBand * 1.2, Math.abs(above))); // 水際
      d += 0.25 * smooth(0.004, 0.03, -wv); // 侵食で削られた谷筋
      return Math.min(1, d * steep * (0.4 + 1.2 * n * n));
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
export function placeVegetation(rules, size, sample, heightAt, view, { maxTrees = 160_000, maxGrass = 450_000 } = {}) {
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

  const out = { conifer: [], broadleaf: [], grass: [], rocks: [], reeds: [], ferns: [], litter: [], needles: [] };

  // ---- 木：カメラの周りの見えている範囲に、格子＋ゆらぎで候補を置き、森の密度で間引く ----
  // 候補の位置は格子ごとのハッシュで決める（視点を変えても同じ所に同じ木が立つ）。
  // 置く範囲は「木が 1 画素ほどに見える距離」まで。数千 km の大地でも、カメラの近くから順に調べる
  const near = treeIndex();
  if (veg.trees > 0) {
    const cell = Math.max(5, veg.treeHeight * 0.55);
    const pix = (2 * Math.tan(halfV)) / (view.height || 1080);
    const reach = Math.min(size * 1.5, Math.max(1500, veg.treeHeight / pix));
    const ci = Math.floor(C[0] / cell), cj = Math.floor(C[2] / cell);
    const n = Math.ceil(reach / cell);
    let count = 0;
    const tryCell = (i, j) => {
      const t = treeAt(i, j, rules, size, sample, heightAt, (x, z) => inView(x, z, veg.treeHeight));
      if (!t) return;
      out[t.kind].push(t.x, t.y, t.z, t.h, t.rot);
      count++;
      // 足元の草・岩・落ち葉が木を避けたり寄ったりできるよう、近くの木を覚える
      if (Math.hypot(t.x - C[0], t.z - C[2]) < 340) near.add(t);
    };
    // 近い順（カメラを囲む四角い輪を、内側から外側へ）
    for (let r = 0; r <= n && count < maxTrees; r++) {
      for (let j = cj - r; j <= cj + r && count < maxTrees; j++) {
        if (j === cj - r || j === cj + r) {
          for (let i = ci - r; i <= ci + r && count < maxTrees; i++) tryCell(i, j);
        } else {
          tryCell(ci - r, j);
          if (r > 0) tryCell(ci + r, j);
        }
      }
    }
  }

  // ---- 草：カメラの足元近く（画面で見分けられる距離）だけ ----
  if (veg.grass > 0) {
    const ground = heightAt(C[0], C[2]);
    const above = C[1] - ground;
    const radius = Math.min(260, Math.max(0, 200 - above * 1.2)); // 高い所から見下ろすときは置かない
    if (radius > 5) {
      // 足元ほど細かく：30 m までは 0.32 m に 1 株、90 m までは 0.8 m、その先は 2 m。近い帯から順に置くので、上限で削られるのは遠く
      const bands = [
        [0, 30, 0.32],
        [30, 90, 0.6],
        [90, radius, 2.0],
      ];
      let count = 0;
      for (const [r0, r1, cell] of bands) {
        if (r0 >= radius) break;
        const n = Math.ceil(Math.min(r1, radius) / cell);
        for (let j = -n; j <= n && count < maxGrass; j++) {
          for (let i = -n; i <= n && count < maxGrass; i++) {
            const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
            const r1r = rand(), r2 = rand(), r3 = rand();
            const d = Math.hypot(x - C[0], z - C[2]);
            // カメラのすぐ周り（1.5 m）には置かない（目の前が草で覆われないように）
            if (d < Math.max(r0, 1.5) || d > Math.min(r1, radius) || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
            if (!inView(x, z, 2)) continue;
            const sm = sample(x, z);
            // 草むらをすき間なく（生える確率を上げる）
            // 幹の根元には生やさない。樹冠の下は日陰なので薄く
            const tr = near.at(x, z);
            if (tr.trunk < 0.35) continue;
            const pg = rules.grass(sm.h, sm.slope, sm.wv, x, z);
            if (r1r > Math.sqrt(pg) * (1 - 0.92 * tr.canopy) * (1 - smooth(radius * 0.6, radius, d) * 0.7)) continue;
            out.grass.push(x, heightAt(x, z) - 0.02, z, 0.35 + r2 * 0.45, r3 * Math.PI * 2);
            count++;
          }
        }
      }
    }
  }
  // ---- 岩と石：カメラの周り 300 m まで（近いほど細かく、小石まで） ----
  {
    const ground = heightAt(C[0], C[2]);
    const radius = Math.min(300, Math.max(0, 260 - (C[1] - ground) * 0.8));
    const bands = [
      [0, 40, 1.5, 0.15, 1.3],
      [40, 120, 4, 0.4, 2.6],
      [120, radius, 9, 0.8, 4.0],
    ];
    for (const [r0, r1, cell, smin, smax] of bands) {
      if (r0 >= radius) break;
      const n = Math.ceil(Math.min(r1, radius) / cell);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
          const a = rand(), b = rand(), c = rand();
          const d = Math.hypot(x - C[0], z - C[2]);
          if (d < r0 || d > Math.min(r1, radius) || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
          if (!inView(x, z, smax)) continue;
          const sm = sample(x, z);
          if (a > rules.rocks(sm.h, sm.slope, sm.wv, x, z)) continue;
          // 大きさは小さいものほど多く（大岩はまれ）
          const s = smin + (smax - smin) * b * b;
          if (near.at(x, z).trunk < s * 0.5 + 0.2) continue; // 幹にめり込ませない
          // 足元の地面を岩の幅で測る：細かい起伏まで入れた傾きが大きい所や段の縁では転がり落ちるので置かない。
          // 置くときは足元のいちばん低い所に合わせて沈める（縁に引っかかって浮かないように）
          const r = s * 0.5;
          const h0 = heightAt(x, z), h1 = heightAt(x + r, z), h2 = heightAt(x - r, z), h3 = heightAt(x, z + r), h4 = heightAt(x, z - r);
          const lo = Math.min(h0, h1, h2, h3, h4), hi = Math.max(h0, h1, h2, h3, h4);
          if ((hi - lo) / (2 * r) > 0.45) continue;
          out.rocks.push(x, lo - s * 0.08, z, s, c * Math.PI * 2);
        }
      }
    }
  }
  // ---- 葦：カメラの周り 150 m まで（水際） ----
  {
    const ground = heightAt(C[0], C[2]);
    const radius = Math.min(150, Math.max(0, 140 - (C[1] - ground) * 0.6));
    for (const [r0, r1, cell] of [[0, 40, 0.45], [40, radius, 1.4]]) {
      if (r0 >= radius) break;
      const n = Math.ceil(Math.min(r1, radius) / cell);
      for (let j = -n; j <= n && out.reeds.length < 150000 * 5; j++) {
        for (let i = -n; i <= n; i++) {
          const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
          const a = rand(), b = rand(), c = rand();
          const d = Math.hypot(x - C[0], z - C[2]);
          if (d < Math.max(r0, 2) || d > Math.min(r1, radius) || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
          if (!inView(x, z, 2.5)) continue;
          const sm = sample(x, z);
          if (a > rules.reeds(sm.h, sm.slope, x, z)) continue;
          if (near.at(x, z).trunk < 0.5) continue;
          out.reeds.push(x, heightAt(x, z) - 0.05, z, 0.8 + b * 0.7, c * Math.PI * 2);
        }
      }
    }
  }
  // ---- シダ：カメラの周り 70 m まで（森の下草） ----
  {
    const ground = heightAt(C[0], C[2]);
    const radius = Math.min(70, Math.max(0, 70 - (C[1] - ground) * 0.5));
    for (const [r0, r1, cell] of [[0, 25, 0.8], [25, radius, 1.8]]) {
      if (r0 >= radius) break;
      const n = Math.ceil(Math.min(r1, radius) / cell);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
          const a = rand(), b = rand(), c = rand();
          const d = Math.hypot(x - C[0], z - C[2]);
          if (d < Math.max(r0, 1.5) || d > Math.min(r1, radius) || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
          if (!inView(x, z, 1.5)) continue;
          const sm = sample(x, z);
          // シダは樹冠の下に寄る（木の無い所では減る）。幹の根元は避ける
          const tr = near.at(x, z);
          if (tr.trunk < 0.5) continue;
          if (a > rules.fern(sm.h, sm.slope, sm.wv, x, z) * (0.45 + 0.55 * tr.canopy)) continue;
          out.ferns.push(x, heightAt(x, z) - 0.03, z, 0.6 + b * 0.8, c * Math.PI * 2);
        }
      }
    }
  }
  // ---- 落ち葉・落ち針：カメラの周り 60 m までの、樹冠の下（幹に近いほど厚く） ----
  if ((veg.litter ?? 0) > 0 && near.count) {
    const ground = heightAt(C[0], C[2]);
    const radius = Math.min(60, Math.max(0, 60 - (C[1] - ground) * 0.5));
    for (const [r0, r1, cell] of [[0, 20, 0.7], [20, radius, 1.5]]) {
      if (r0 >= radius) break;
      const n = Math.ceil(Math.min(r1, radius) / cell);
      for (let j = -n; j <= n; j++) {
        for (let i = -n; i <= n; i++) {
          const x = C[0] + (i + rand()) * cell, z = C[2] + (j + rand()) * cell;
          const a = rand(), b = rand(), c = rand();
          const d = Math.hypot(x - C[0], z - C[2]);
          if (d < Math.max(r0, 1) || d > Math.min(r1, radius) || Math.abs(x) > size / 2 || Math.abs(z) > size / 2) continue;
          if (!inView(x, z, 1.5)) continue;
          const tr = near.at(x, z);
          if (tr.canopy <= 0 || tr.trunk < 0.15) continue;
          if (a > tr.canopy * Math.min(1, veg.litter * 1.4)) continue;
          const sm = sample(x, z);
          if (sm.slope > 0.8) continue; // 急な斜面には溜まらない
          (tr.kind === 'conifer' ? out.needles : out.litter).push(x, heightAt(x, z) - 0.01, z, cell * (1.7 + b * 0.8), c * Math.PI * 2);
        }
      }
    }
  }
  return {
    litter: new Float32Array(out.litter),
    needles: new Float32Array(out.needles),
    conifer: new Float32Array(out.conifer),
    broadleaf: new Float32Array(out.broadleaf),
    grass: new Float32Array(out.grass),
    rocks: new Float32Array(out.rocks),
    reeds: new Float32Array(out.reeds),
    ferns: new Float32Array(out.ferns),
  };
}

// 近くの木の索引（4 m 四方ごと）。at(x, z): { trunk: 幹の表面までの距離 (m), canopy: 樹冠の下の度合い 0..1, kind: いちばん覆っている木の種類 }
function treeIndex() {
  const G = 4, grid = new Map();
  let count = 0, maxR = 0;
  const key = (i, j) => i * 73856093 + j * 19349663;
  const none = { trunk: Infinity, canopy: 0, kind: null };
  return {
    get count() { return count; },
    add(t) {
      const k = key(Math.floor(t.x / G), Math.floor(t.z / G));
      if (!grid.has(k)) grid.set(k, []);
      // 幹の太さと樹冠の広がり（detailedPlants の形に合わせた、高さに対する割合）
      const crown = t.h * (t.kind === 'conifer' ? 0.24 : 0.36);
      grid.get(k).push({ x: t.x, z: t.z, trunk: t.h * (t.kind === 'conifer' ? 0.026 : 0.034), crown, kind: t.kind });
      maxR = Math.max(maxR, crown);
      count++;
    },
    at(x, z) {
      if (!count) return none;
      const n = Math.ceil(maxR / G), gi = Math.floor(x / G), gj = Math.floor(z / G);
      let trunk = Infinity, canopy = 0, best = 0, kind = null;
      for (let j = gj - n; j <= gj + n; j++)
        for (let i = gi - n; i <= gi + n; i++) {
          const list = grid.get(key(i, j));
          if (!list) continue;
          for (const t of list) {
            const d = Math.hypot(x - t.x, z - t.z);
            trunk = Math.min(trunk, d - t.trunk);
            if (d >= t.crown * 1.15) continue;
            // 樹冠の縁まではほぼ覆われ、外へ少しぼかす。重なる樹冠は足し合わせる（隙間の木漏れ日は残る）
            const c = 1 - smooth(t.crown * 0.55, t.crown * 1.15, d);
            canopy = 1 - (1 - canopy) * (1 - c);
            if (c > best) (best = c), (kind = t.kind);
          }
        }
      return { trunk, canopy, kind };
    },
  };
}

// 木の格子 1 マス（番号 i, j）に木が立つか。立つなら { x, y, z, h, rot, kind }（y は根元を少し埋めた高さ）。
// 一枚絵とリアルタイム表示で同じ木が同じ所に立つよう、乱数は格子ごとのハッシュで決める
// 手で植えた・伐った跡を 250 m 四方ごとに仕分けて、その点に効く跡だけをすぐ引けるようにする
function paintIndex(strokes) {
  if (!strokes?.length) return null;
  const C = 250;
  const grid = new Map();
  for (const p of strokes) {
    for (let gi = Math.floor((p.x - p.r) / C); gi <= Math.floor((p.x + p.r) / C); gi++)
      for (let gj = Math.floor((p.z - p.r) / C); gj <= Math.floor((p.z + p.r) / C); gj++) {
        const k = `${gi},${gj}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
      }
  }
  const none = [];
  return (x, z) => grid.get(`${Math.floor(x / C)},${Math.floor(z / C)}`) ?? none;
}

export function treeCellSize(veg) {
  return Math.max(5, veg.treeHeight * 0.55);
}
export function treeAt(i, j, rules, size, sample, heightAt, accept = null) {
  const veg = rules.veg;
  const cell = treeCellSize(veg);
  const seed = (veg.seed | 0) + 4242;
  const x = (i + hash2(i, j, seed)) * cell, z = (j + hash2(i, j, seed + 1)) * cell;
  if (Math.abs(x) > size / 2 || Math.abs(z) > size / 2) return null;
  if (accept && !accept(x, z)) return null;
  const s = sample(x, z);
  if (hash2(i, j, seed + 2) > rules.forest(s.h, s.slope, s.wv, x, z)) return null;
  const y = heightAt(x, z);
  const h = veg.treeHeight * (0.55 + hash2(i, j, seed + 3) * 0.75);
  const kind = hash2(i, j, seed + 4) < rules.coniferChance(y) ? 'conifer' : 'broadleaf';
  return { x, y: y - h * 0.03, z, h, rot: hash2(i, j, seed + 5) * Math.PI * 2, kind };
}

function norm(v) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}
