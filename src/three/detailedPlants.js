import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise.js';

// 一枚絵用の細かい植物（高さ 1 の単位形状。置くときに木の高さを掛ける）。
// 木は枝分かれした幹・枝と、その先に付く何千枚もの葉のカード。草は 1 本ずつの葉と、ところどころの花。
// 色は頂点の色に入れる（材質の色を掛けるので、葉・幹・草の基本の色は呼ぶ側が決める）。
// 同じ形を並べるだけ（インスタンス）なので、1 本を細かくしても全体の重さはあまり増えない。

const up = new THREE.Vector3(0, 1, 0);

// a から b へ向かう円柱（下 r0、上 r1）
function limb(a, b, r0, r1, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, true).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g.toNonIndexed();
}

// 葉のカードを書き込む先（位置・法線・色）
class Leaves {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
  }
  // 中心 c、向き（葉の面の法線）n、長さ L、幅 W、色の明るさ v（ゆらぎ）。法線は樹冠の外向き out で揃える（ふんわりした陰影）
  add(c, dir, n, L, W, v, out, hue = 0) {
    const side = new THREE.Vector3().crossVectors(dir, n).normalize().multiplyScalar(W / 2);
    const tip = c.clone().addScaledVector(dir, L / 2), base = c.clone().addScaledVector(dir, -L / 2);
    const l = c.clone().sub(side), r = c.clone().add(side);
    // 菱形を 2 枚の三角形で（少し折って立体感）
    const fold = n.clone().multiplyScalar(W * 0.15);
    for (const p of [base, l.clone().add(fold), tip, base, tip, r.clone().add(fold)]) this.pos.push(p.x, p.y, p.z);
    for (let k = 0; k < 6; k++) {
      this.nrm.push(out.x, out.y, out.z);
      this.col.push(v * (1 + hue * 0.25), v, v * (1 - hue * 0.3));
    }
  }
  // 葉の形の葉（付け根・左右 2 点ずつ・先の 6 点、三角形 4 枚）。中筋で少し折り、先は反る。葉柄側は少し暗く
  addLeaf(c, dir, n, L, W, v, out, hue = 0) {
    const side = new THREE.Vector3().crossVectors(dir, n).normalize();
    const P = (u, w, lift) => c.clone().addScaledVector(dir, (u - 0.5) * L).addScaledVector(side, w * W * 0.5).addScaledVector(n, lift * W);
    const base = P(0, 0, 0), tip = P(1, 0, 0.12);
    const l1 = P(0.3, -1, 0.18), l2 = P(0.68, -0.8, 0.2), r1 = P(0.3, 1, 0.18), r2 = P(0.68, 0.8, 0.2);
    const mid = P(0.5, 0, 0);
    const cb = [v * 0.85 * (1 + hue * 0.25), v * 0.85, v * 0.85 * (1 - hue * 0.3)], ct = [v * (1 + hue * 0.25), v, v * (1 - hue * 0.3)];
    for (const [p, k] of [[base, cb], [l1, ct], [mid, ct], [mid, ct], [l1, ct], [l2, ct], [mid, ct], [l2, ct], [tip, ct], [base, cb], [mid, ct], [r1, ct], [mid, ct], [r2, ct], [r1, ct], [mid, ct], [tip, ct], [r2, ct]]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(out.x, out.y, out.z);
      this.col.push(k[0], k[1], k[2]);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// 樹皮のある幹：縦に走る溝（ねじれと途切れのある畝）と、根元の張り出し。溝は細く暗く、畝は明るく（頂点の色）。
// 近くで見たとき、つるりとした円柱に見えないように
function barkLimb(a, b, r0, r1, seed, { ridges = 14, depth = 0.22, flare = 0.4 } = {}) {
  const rand = mulberry32(seed * 977 + 3);
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, 36, 24, true).translate(0, len / 2, 0);
  const p = g.attributes.position;
  const ph = Array.from({ length: 4 }, () => rand() * Math.PI * 2);
  const twist = (rand() - 0.5) * 1.2;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y / len;
    const ang = Math.atan2(z, x);
    // 畝の模様：角度に沿った縞を、高さでゆっくりねじり、ところどころで途切れさせる
    const w = ang * ridges + twist * t * 6 + Math.sin(t * 9 + ph[0]) * 0.8 + Math.sin(t * 23 + ph[1] + ang * 3) * 0.35;
    const ridge = Math.pow(Math.abs(Math.sin(w / 2)), 0.6) * (0.75 + 0.25 * Math.sin(t * 31 + ph[2] + ang * 5));
    // 根元の張り出し：太く、根の分かれ目で凸凹に
    const base = flare * Math.exp(-t * 14) * (0.6 + 0.4 * Math.max(0, Math.cos(ang * 5 + ph[3])));
    const k = (1 - depth * (1 - ridge)) * (1 + base);
    p.setXYZ(i, x * k, y, z * k);
    // 割れ目の奥は日が届かず暗い（畝との明暗の差が小さいと、日陰の幹がのっぺりする）
    const v = (0.36 + 0.95 * ridge * ridge) * (0.9 + rand() * 0.2);
    col.set([v * 1.04, v, v * 0.94], i * 3);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g.toNonIndexed();
}
const withColor = (list) => list.map((g) => (g.attributes.color ? g : tint(g, 1)));

// 頂点の色を明るさ v で一様に
function tint(g, v = 1) {
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(v), 3));
  return g;
}

const randDir = (rand) => {
  const u = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(a), u, s * Math.sin(a));
};

// 広葉樹：幹 → 主枝 5〜6 本 → 小枝 → 葉の房。樹冠は高さ 0.35〜0.95、幅およそ ±0.32（リアルタイム表示の木と同じ大きさ）
// hero: カメラのすぐそばの木用。1 枚の大きな菱形のかわりに、葉の形の小さな葉を 5 枚ずつ寄せる（葉 1 枚は 6 頂点 ×3）
export function detailedBroadleaf(seed = 1, hero = false) {
  const rand = mulberry32(seed * 7919 + 13);
  const wood = [];
  const leaves = new Leaves();
  const crownC = new THREE.Vector3(0, 0.66, 0);
  const trunkTop = new THREE.Vector3((rand() - 0.5) * 0.04, 0.42 + rand() * 0.06, (rand() - 0.5) * 0.04);
  wood.push(barkLimb(new THREE.Vector3(0, -0.02, 0), trunkTop, 0.034, 0.024, seed));
  const nMain = 5 + Math.floor(rand() * 2);
  for (let b = 0; b < nMain; b++) {
    const a = (b / nMain) * Math.PI * 2 + rand() * 0.8;
    const tilt = 0.45 + rand() * 0.45;
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const start = new THREE.Vector3(0, 0.3 + rand() * 0.14, 0).lerp(trunkTop, 0.5);
    const len = 0.2 + rand() * 0.08;
    const end = start.clone().addScaledVector(dir, len);
    wood.push(limb(start, end, 0.016, 0.009, 6));
    // 小枝：主枝の途中と先から
    const nSub = 3 + Math.floor(rand() * 2);
    for (let s2 = 0; s2 < nSub; s2++) {
      const p = start.clone().lerp(end, 0.45 + (s2 / nSub) * 0.55);
      const sd = dir.clone().add(randDir(rand).multiplyScalar(0.9)).add(new THREE.Vector3(0, 0.35, 0)).normalize();
      wood.push(limb(p, p.clone().addScaledVector(sd, 0.08 + rand() * 0.06), 0.007, 0.003, 5));
    }
  }
  // 樹冠：楕円体（中心 0.66、横 ±0.32・縦 ±0.27）の中を葉の房で埋める。房は外側ほど多く、
  // 一部は大きな塊の偏り（ノイズ）でへこませて、輪郭をでこぼこに
  const lumps = Array.from({ length: 7 }, () => ({ d: randDir(rand), k: 0.75 + rand() * 0.5 }));
  const nCl = 150;
  for (let c = 0; c < nCl; c++) {
    const d = randDir(rand);
    let bulge = 0;
    for (const l of lumps) bulge += Math.max(0, d.dot(l.d)) ** 3 * (l.k - 0.75);
    const r = Math.pow(rand(), 0.35) * (0.82 + bulge * 0.5);
    const cc = crownC.clone().add(new THREE.Vector3(d.x * 0.32, d.y * 0.27, d.z * 0.32).multiplyScalar(r));
    const out = cc.clone().sub(crownC).normalize();
    const nLeaf = 24 + Math.floor(rand() * 12);
    for (let k = 0; k < nLeaf; k++) {
      const lc = cc.clone().addScaledVector(randDir(rand), 0.012 + rand() * 0.04);
      const lo = lc.clone().sub(crownC).normalize();
      const n = lo.clone().add(randDir(rand).multiplyScalar(0.8)).normalize();
      const ld = new THREE.Vector3().crossVectors(n, randDir(rand)).normalize();
      // 外側・上ほど日が当たって明るく、内側は暗い
      const v = (0.55 + rand() * 0.4) * (0.75 + r * 0.3) + Math.max(0, lo.y) * 0.15;
      const hue = (rand() - 0.5) * 2;
      if (!hero) {
        leaves.add(lc, ld, n, 0.022 + rand() * 0.01, 0.012 + rand() * 0.006, v, lo.clone().lerp(out, 0.5).normalize(), hue);
        continue;
      }
      for (let m = 0; m < 5; m++) {
        const mc = lc.clone().addScaledVector(randDir(rand), 0.004 + rand() * 0.008);
        const mn = n.clone().addScaledVector(randDir(rand), 0.5).normalize();
        const md = new THREE.Vector3().crossVectors(mn, randDir(rand)).normalize();
        const L = 0.008 + rand() * 0.005;
        leaves.addLeaf(mc, md, mn, L, L * (0.5 + rand() * 0.15), v * (0.85 + rand() * 0.3), lo.clone().lerp(out, 0.5).normalize(), hue + (rand() - 0.5) * 0.6);
      }
    }
  }
  return {
    trunk: mergeGeometries(withColor(wood)),
    crown: leaves.geometry(),
  };
}

// 針葉樹：まっすぐな幹と、下ほど長く垂れる枝の段。枝に沿って針葉の房のカード
// hero: カメラのすぐそばの木用。枝の両側に互い違いの小枝を出し、小枝に沿って小さな針葉の房を並べる
// （ふつうの房は実寸で 1 m ほどあり、目の前では段々の板に見えるため。三角形は 20 倍ほどになる）
export function detailedConifer(seed = 1, hero = false) {
  const rand = mulberry32(seed * 104729 + 7);
  // 針葉樹の樹皮は細かく浅い縦の割れ目
  const wood = [barkLimb(new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(0, 0.97, 0), 0.026, 0.004, seed + 50, { ridges: 18, depth: 0.18, flare: 0.3 })];
  const leaves = new Leaves();
  for (let y = 0.1; y < 0.95; y += 0.022 + rand() * 0.01) {
    const t = (y - 0.12) / 0.83; // 0 = 下、1 = 頂
    const n = 5 + Math.floor(rand() * 3);
    const len = 0.03 + 0.25 * Math.pow(1 - t, 1.05) * (0.85 + rand() * 0.3);
    for (let b = 0; b < n; b++) {
      const a = (b / n) * Math.PI * 2 + rand() * 0.9;
      const droop = -0.15 - (1 - t) * 0.35 + rand() * 0.1;
      const dir = new THREE.Vector3(Math.cos(a), droop, Math.sin(a)).normalize();
      const s = new THREE.Vector3(0, y, 0), e = s.clone().addScaledVector(dir, len);
      if (len > 0.08) wood.push(limb(s, e, 0.004, 0.0015, hero ? 6 : 4));
      if (hero) {
        const nb = Math.max(3, Math.round(len / 0.006));
        for (let k = 1; k <= nb; k++) {
          const f = (k - 0.5 * rand()) / nb;
          const c = s.clone().lerp(e, f);
          c.y += Math.sin(f * Math.PI) * 0.01 - f * f * 0.02;
          for (const sd of [-1, 1]) {
            const bl = len * 0.3 * (1 - f * 0.65) * (0.7 + rand() * 0.6) + 0.006;
            const bd = dir.clone().applyAxisAngle(up, sd * (0.7 + rand() * 0.4));
            bd.y -= 0.1 + rand() * 0.25;
            bd.normalize();
            const nt = Math.max(2, Math.round(bl / 0.0034));
            for (let j = 1; j <= nt; j++) {
              const g = j / nt;
              const q = c.clone().addScaledVector(bd, bl * g);
              q.y -= g * g * bl * 0.3;
              const out = new THREE.Vector3(q.x, (q.y - 0.5) * 0.4 + 0.35, q.z).normalize();
              // 小枝の先は新芽で明るく、枝の奥（幹に近い所）は暗い
              const v = (0.5 + rand() * 0.35) * (0.75 + 0.35 * f) * (0.85 + 0.3 * g) + t * 0.12;
              for (const s2 of [-1, 1]) {
                const ld = bd.clone().applyAxisAngle(up, s2 * (0.6 + rand() * 0.5));
                ld.y += (rand() - 0.3) * 0.5;
                ld.normalize();
                const nrm = new THREE.Vector3().crossVectors(ld, bd);
                if (nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);
                nrm.normalize();
                if (nrm.y < 0) nrm.negate();
                leaves.add(q.clone().addScaledVector(ld, 0.0018), ld, nrm.add(new THREE.Vector3(0, 0.5, 0)).normalize(), 0.0042 * (1 - g * 0.3), 0.0016, v, out, rand() - 0.5);
              }
            }
          }
        }
        continue;
      }
      // 針葉の房：枝に沿って 2 列、先ほど細かく
      const nn = Math.max(3, Math.round(len / 0.009));
      for (let k = 1; k <= nn; k++) {
        const f = k / nn;
        const c = s.clone().lerp(e, f);
        c.y += Math.sin(f * Math.PI) * 0.01 - f * f * 0.02;
        const out = new THREE.Vector3(c.x, (c.y - 0.5) * 0.4 + 0.35, c.z).normalize();
        for (const sd of [-1, 1]) {
          const ld = dir.clone().applyAxisAngle(up, sd * (0.6 + rand() * 0.4)).normalize();
          const nrm = new THREE.Vector3().crossVectors(ld, dir).normalize();
          if (nrm.y < 0) nrm.negate();
          const v = 0.65 + rand() * 0.35 + t * 0.15;
          leaves.add(c.clone().addScaledVector(ld, 0.012), ld, nrm.add(new THREE.Vector3(0, 0.6, 0)).normalize(), 0.034 * (1 - f * 0.4), 0.02, v, out, (rand() - 0.5));
        }
      }
    }
  }
  return { trunk: mergeGeometries(withColor(wood)), crown: leaves.geometry() };
}

// 草の株：細い葉を 48 本ほど、幅 0.5 ほどに広げる（根元は暗く先は明るい）
export function detailedGrass(seed = 1) {
  const rand = mulberry32(seed * 31 + 5);
  const pos = [], nrm = [], col = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 48; i++) {
    const a = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.24;
    const bx = Math.cos(a) * r0, bz = Math.sin(a) * r0;
    const lean = 0.08 + rand() * 0.45;
    const la = a + (rand() - 0.5) * 1.2;
    const h = 0.4 + rand() * 0.7;
    const w = 0.012 + rand() * 0.01;
    const segs = 5;
    // 葉ごとの色：明るさと色合いをばらつかせ、1 割ほどは枯れた黄土色の葉。先は枯れ色に
    const v = 0.7 + rand() * 0.55;
    const dry = rand() < 0.12;
    const hue = (rand() - 0.5) * 0.3; // 正 = 黄み、負 = 青み
    const tipDry = 0.6 + rand() * 0.3; // ここ（0..1）より先が枯れ始める
    const pts = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const off = lean * t * t * h;
      pts.push(new THREE.Vector3(bx + Math.cos(la) * off, t * h * (1 - lean * t * 0.25), bz + Math.sin(la) * off));
    }
    const side = new THREE.Vector3(-Math.sin(la), 0, Math.cos(la));
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs;
      const p0 = pts[s], p1 = pts[s + 1];
      const tang = p1.clone().sub(p0).normalize();
      // 葉の面の向き：横向きと伸びる向きから。上向きと半々に混ぜる（草原が暗くなりすぎないように）
      const face = new THREE.Vector3().crossVectors(side, tang).normalize();
      if (face.y < 0) face.negate();
      const w0 = w * (1 - t0 * 0.95), w1 = w * (1 - t1 * 0.95);
      // 中肋で左右に少し折る（左右の半面で光の当たり方が違う）
      const fold = (wid) => face.clone().multiplyScalar(-wid * 0.35);
      const m0 = p0, m1 = p1;
      const l0 = p0.clone().addScaledVector(side, -w0).add(fold(w0)), r0 = p0.clone().addScaledVector(side, w0).add(fold(w0));
      const l1 = p1.clone().addScaledVector(side, -w1).add(fold(w1)), r1 = p1.clone().addScaledVector(side, w1).add(fold(w1));
      const nL = face.clone().addScaledVector(side, -0.35).normalize().lerp(up, 0.45).normalize();
      const nR = face.clone().addScaledVector(side, 0.35).normalize().lerp(up, 0.45).normalize();
      const colAt = (t) => {
        let c = v * (0.42 + 0.78 * t); // 根元は陰で暗く、先は明るい
        let r = c * (1 + hue + t * 0.1), g = c, bb = c * (1 - hue * 0.8 - t * 0.15);
        const brown = dry ? 1 : Math.max(0, (t - tipDry) / (1 - tipDry)) * 0.8;
        // 枯れ色（素材の緑に掛けて黄土色になる倍率）
        r += (c * 1.9 - r) * brown;
        g += (c * 1.35 - g) * brown;
        bb += (c * 0.7 - bb) * brown;
        return [r, g, bb];
      };
      const c0 = colAt(t0), c1 = colAt(t1);
      const tri = (A, B, C, n, cA, cB, cC) => {
        for (const [P, cc] of [[A, cA], [B, cB], [C, cC]]) {
          pos.push(P.x, P.y, P.z);
          nrm.push(n.x, n.y, n.z);
          col.push(cc[0], cc[1], cc[2]);
        }
      };
      tri(l0, m0, m1, nL, c0, c0, c1);
      tri(l0, m1, l1, nL, c0, c1, c1);
      tri(m0, r0, r1, nR, c0, c0, c1);
      tri(m0, r1, m1, nR, c0, c1, c1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// 野の花：草の株の上に、白や黄色の小さな花を数輪（色は頂点に、材質は白）
export function detailedFlowers(seed = 1) {
  const rand = mulberry32(seed * 977 + 3);
  const pal = [[1, 0.95, 0.4], [0.97, 0.97, 0.95], [0.95, 0.75, 0.25], [0.8, 0.6, 0.95]];
  const leaves = new Leaves();
  const n = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const c = new THREE.Vector3((rand() - 0.5) * 0.3, 0.55 + rand() * 0.45, (rand() - 0.5) * 0.3);
    const colr = pal[Math.floor(rand() * pal.length)];
    // 花びら 5 枚
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + rand() * 0.3;
      const d = new THREE.Vector3(Math.cos(a), 0.15, Math.sin(a)).normalize();
      leaves.add(c.clone().addScaledVector(d, 0.025), d, up, 0.05, 0.03, 1, up);
      const base = leaves.col.length - 18;
      for (let j = 0; j < 6; j++) leaves.col.splice(base + j * 3, 3, colr[0], colr[1], colr[2]);
    }
  }
  return leaves.geometry();
}

// 岩：細かい多面体を、大きなうねりと細かい凹凸でゆがめ、底を平らに（地面に埋まる）。くぼみは暗く、上面は少し苔むした色
export function detailedRock(seed = 1) {
  const rand = mulberry32(seed * 7331 + 17);
  // 20 面体は頂点を共有しないので、そのままでは面ごとに平らな陰（角ばった多面体）になる。頂点をつないでなめらかな陰に
  const g0 = new THREE.IcosahedronGeometry(0.5, 4);
  g0.deleteAttribute('normal');
  const g = mergeVertices(g0); // uv（球の緯度経度）は残す：岩肌の模様の地図を貼る
  const p = g.attributes.position;
  // 方向ごとの凹凸：ランダムな方向の波を重ねる
  const waves = Array.from({ length: 9 }, (_, k) => ({ d: randDir(rand), f: 2 + k * 1.6 + rand() * 2, a: 0.16 / (1 + k * 0.7), ph: rand() * 6.28 }));
  const sx = 0.8 + rand() * 0.6, sy = 0.6 + rand() * 0.4, sz = 0.7 + rand() * 0.5;
  const col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const dir = v.clone().normalize();
    let disp = 0;
    for (const w of waves) disp += Math.sin(dir.dot(w.d) * w.f + w.ph) * w.a;
    // 表面の細かいざらつき（近くで見たときの岩らしさ）
    disp += (Math.sin(dir.x * 41 + dir.y * 17) * Math.sin(dir.z * 37 - dir.y * 23) + Math.sin(dir.x * 83 - dir.z * 59) * 0.5) * 0.012;
    // 角張らせる：値を段に寄せる
    const r = 0.5 * (1 + disp);
    v.copy(dir).multiplyScalar(r);
    v.set(v.x * sx, Math.max(-0.15, v.y * sy), v.z * sz);
    p.setXYZ(i, v.x, v.y, v.z);
    const cav = Math.max(0, Math.min(1, 0.6 + disp * 2.2)); // くぼみほど小さい
    const moss = Math.max(0, dir.y - 0.5) * 0.6;
    const k = 0.7 + 0.3 * cav;
    col[i * 3] = k * (1 - moss * 0.35);
    col[i * 3 + 1] = k * (1 + moss * 0.15);
    col[i * 3 + 2] = k * (1 - moss * 0.5);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeTangents(); // 凹凸の地図に使う
  return g.toNonIndexed();
}

// 葦（ヨシ）の株：背の高い細い葉を 40 本ほど、まっすぐ上へ（先は風でしなる）。何本かは穂を付ける。根元は暗く、先は枯れ色寄り
export function detailedReeds(seed = 1) {
  const rand = mulberry32(seed * 53 + 11);
  const pos = [], nrm = [], col = [];
  const blade = (bx, bz, la, h, w, lean, v, head) => {
    const segs = 6;
    const pts = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const off = lean * t * t * t * h;
      pts.push([bx + Math.cos(la) * off, t * h, bz + Math.sin(la) * off, w * (1 - t * (head ? 0.4 : 0.9)), t]);
    }
    const px = -Math.sin(la), pz = Math.cos(la);
    for (let s = 0; s < segs; s++) {
      const [x0, y0, z0, w0, t0] = pts[s], [x1, y1, z1, w1, t1] = pts[s + 1];
      const quad = [
        [x0 - px * w0, y0, z0 - pz * w0, t0], [x0 + px * w0, y0, z0 + pz * w0, t0], [x1 + px * w1, y1, z1 + pz * w1, t1],
        [x0 - px * w0, y0, z0 - pz * w0, t0], [x1 + px * w1, y1, z1 + pz * w1, t1], [x1 - px * w1, y1, z1 - pz * w1, t1],
      ];
      for (const [x, y, z, t] of quad) {
        pos.push(x, y, z);
        nrm.push(Math.cos(la) * 0.4, 0.8, Math.sin(la) * 0.4);
        const c = v * (0.4 + 0.75 * t);
        col.push(c * (1 + t * 0.35), c * (1 + t * 0.1), c * (1 - t * 0.3));
      }
    }
    // 穂：茎の先に、茶色い紡錘形を十字の 2 枚で
    if (head) {
      const [hx, hy, hz] = pts[segs];
      for (const [ax, az] of [[1, 0], [0, 1]]) {
        const hw = 0.022, hl = 0.16;
        const q = [[-hw, 0], [hw, 0], [hw * 0.6, hl], [-hw, 0], [hw * 0.6, hl], [-hw * 0.6, hl]];
        for (const [u, y] of q) {
          pos.push(hx + ax * u, hy + y, hz + az * u);
          nrm.push(az, 0.3, ax);
          col.push(0.42 * v, 0.3 * v, 0.2 * v);
        }
      }
    }
  };
  for (let i = 0; i < 40; i++) {
    const a = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.2;
    blade(Math.cos(a) * r0, Math.sin(a) * r0, a + (rand() - 0.5) * 1.5, 0.9 + rand() * 0.8, 0.014 + rand() * 0.012, 0.1 + rand() * 0.35, 0.85 + rand() * 0.5, rand() < 0.07);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// 落ち葉の吹きだまり（半径 0.5 の円の中に地面すれすれに寝た葉）。needles: 細い落ち針
export function detailedLitter(seed = 1, needles = false) {
  const rand = mulberry32(seed * 613 + 71);
  const pos = [], nrm = [], col = [];
  const n = needles ? 260 : 70;
  for (let k = 0; k < n; k++) {
    // 中ほどに多く、縁へまばらに
    const r = 0.5 * Math.sqrt(rand()) * (0.6 + 0.4 * rand()), a = rand() * Math.PI * 2;
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r, cy = 0.004 + rand() * 0.012;
    const L = needles ? 0.05 + rand() * 0.03 : 0.07 + rand() * 0.05, W = needles ? 0.003 : L * (0.45 + rand() * 0.25);
    const th = rand() * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
    const sx = -dz * W / 2, sz = dx * W / 2;
    const tilt = (rand() - 0.5) * 0.3 * L; // 少し反り返る
    const v = 0.65 + rand() * 0.6, hue = rand();
    const pts = [
      [cx - dx * L / 2, cy, cz - dz * L / 2],
      [cx + sx, cy + tilt, cz + sz],
      [cx + dx * L / 2, cy + Math.abs(tilt), cz + dz * L / 2],
      [cx - sx, cy - tilt * 0.5, cz - sz],
    ];
    for (const q of [0, 1, 2, 0, 2, 3]) {
      pos.push(...pts[q]);
      nrm.push(0, 1, 0);
      // 葉ごとに色をずらす（赤み・黄み・枯れ色）
      col.push(v * (1 + (hue - 0.5) * 0.35), v * (1 - Math.abs(hue - 0.5) * 0.2), v * (0.9 - hue * 0.25));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// シダの株：弓なりに広がる葉（8〜11 枚）。葉は茶色い葉柄から中軸が伸び、左右に互い違いの小葉が並ぶ。
// 小葉は付け根から先へ細る槍形で、縁は小さな裂片の凹凸。中筋で山なりに反り、先は少し垂れる。
// 葉は先ほど若く明るい黄緑、古い葉は小葉の先から黄ばむ。三角形の切り絵に見えないように
export function detailedFern(seed = 1) {
  const rand = mulberry32(seed * 101 + 29);
  const pos = [], nrm = [], col = [];
  const vert = (p, n, c) => {
    pos.push(p.x, p.y, p.z);
    nrm.push(n.x, n.y, n.z);
    col.push(c[0], c[1], c[2]);
  };
  const tri = (a, b, c) => {
    for (const q of [a, b, c]) vert(q.p, q.n, q.c);
  };
  // 緑から枯れ色（黄土）へ d だけ寄せた色。v は明るさ、y は黄み
  const tone = (v, y, d) => [v * (0.86 + y * 0.3) * (1 - d) + v * 1.9 * d, v * (1 - d) + v * 1.4 * d, v * (0.78 - y * 0.25) * (1 - d) + v * 0.6 * d];
  const fronds = 8 + Math.floor(rand() * 4);
  for (let f = 0; f < fronds; f++) {
    const az = (f / fronds) * Math.PI * 2 + rand() * 0.6;
    const L = 0.7 + rand() * 0.4;
    const rise = 0.6 + rand() * 0.45; // 立ち上がり
    const curl = (rand() - 0.5) * 0.25; // 横への曲がり
    const roll = (rand() - 0.5) * 1.1; // 先へ向かうねじれ
    const old = rand() < 0.2 ? 0.35 + rand() * 0.4 : rand() * 0.08; // 古い葉ほど枯れ色
    const v0 = 0.78 + rand() * 0.4;
    const dir = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side0 = new THREE.Vector3(-dir.z, 0, dir.x);
    const at = (t) => new THREE.Vector3().addScaledVector(dir, L * t).addScaledVector(side0, L * curl * t * t).setY(L * (rise * t - (rise + 0.2) * t * t));
    // 中軸の向きの枠（接線・横・面の法線）。横はねじれで回す
    const frame = (t) => {
      const tang = at(Math.min(1, t + 0.01)).sub(at(Math.max(0, t - 0.01))).normalize();
      let side = side0.clone().addScaledVector(tang, -side0.dot(tang)).normalize();
      let n = new THREE.Vector3().crossVectors(side, tang).normalize();
      if (n.y < 0) n.negate();
      const r = roll * t;
      side = side.multiplyScalar(Math.cos(r)).addScaledVector(n, Math.sin(r)).normalize();
      n = new THREE.Vector3().crossVectors(side, tang).normalize();
      if (n.y < 0) n.negate();
      return { tang, side, n };
    };
    // 中軸（細い帯。根元は茶色い葉柄）
    const RS = 20;
    for (let k = 0; k < RS; k++) {
      const q = [k / RS, (k + 1) / RS].map((t) => {
        const { side, n } = frame(t);
        const w = L * 0.008 * (1 - t * 0.7);
        const c = t < 0.15 ? tone(v0 * 0.55, 0.6, 0.7) : tone(v0 * 0.85, 0.3, old * 0.6);
        const p = at(t);
        return [{ p: p.clone().addScaledVector(side, -w), n, c }, { p: p.clone().addScaledVector(side, w), n, c }];
      });
      tri(q[0][0], q[1][0], q[1][1]);
      tri(q[0][0], q[1][1], q[0][1]);
    }
    // 小葉：根元 12% は葉柄で小葉なし。左右で半歩ずらす（互い違い）
    const P = 20 + Math.floor(rand() * 5);
    const K = 8; // 小葉の長さ方向の分割（偶数番が裂片の山、奇数番が谷）
    for (let i = 0; i < P; i++) {
      for (const sg of [-1, 1]) {
        const t = 0.13 + (0.85 * (i + (sg > 0 ? 0.5 : 0))) / P;
        if (t > 0.985) continue;
        const { tang, side, n } = frame(t);
        // 小葉の長さ：下から 1/3 ほどで最大、先へ細る（先端は小さな小葉が詰まる）
        const ll = 0.2 * L * Math.pow(Math.sin(Math.PI * Math.min(1, (t - 0.08) * 1.05)), 0.8) * (1 - t * 0.45) * (0.9 + rand() * 0.2);
        if (ll < 0.006) continue;
        const sweep = 0.35 + t * 0.5; // 先の小葉ほど前へ向く
        const d = side.clone().multiplyScalar(sg * Math.cos(sweep)).addScaledVector(tang, Math.sin(sweep)).normalize();
        const wd = new THREE.Vector3().crossVectors(n, d).normalize(); // 小葉の幅の向き
        const base = at(t);
        const droop = 0.18 + rand() * 0.15;
        const lobes = ll > 0.05 * L;
        const vp = v0 * (0.85 + rand() * 0.25) * (0.75 + 0.45 * t);
        const yel = 0.25 + t * 0.6; // 先ほど若い黄緑
        const mids = [], edges = [[], []];
        for (let k = 0; k <= K; k++) {
          const u = k / K;
          const p = base.clone().addScaledVector(d, ll * u).addScaledVector(n, -droop * ll * u * u);
          // 幅：付け根で少しくびれ、先へ細る。縁は裂片の山と谷
          const w = ll * 0.13 * Math.min(1, 0.45 + u * 4) * Math.pow(1 - u, 0.85) * (lobes && k % 2 ? 0.62 : 1);
          const dry = Math.min(1, old * (0.4 + 1.2 * u * u) + (rand() < 0.04 ? 0.3 : 0));
          const cm = tone(vp * (0.9 + 0.2 * u), yel, dry);
          mids.push({ p, n, c: cm });
          for (const e of [0, 1]) {
            const s2 = e ? 1 : -1;
            const pe = p.clone().addScaledVector(wd, s2 * w).addScaledVector(n, -w * 0.35); // 縁は下へ反る
            const ne = n.clone().addScaledVector(wd, s2 * 0.45).normalize();
            edges[e].push({ p: pe, n: ne, c: tone(vp * 0.92, yel, Math.min(1, dry * 1.2)) });
          }
        }
        for (let k = 0; k < K; k++) {
          tri(mids[k], edges[1][k], edges[1][k + 1]);
          tri(mids[k], edges[1][k + 1], mids[k + 1]);
          tri(mids[k], mids[k + 1], edges[0][k + 1]);
          tri(mids[k], edges[0][k + 1], edges[0][k]);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// ヤシ：しなって傾いた細い幹（節の輪の濃淡）と、先端から放射状に垂れる羽状の葉 14 枚ほど
export function detailedPalm(seed = 1) {
  const rand = mulberry32(seed * 389 + 41);
  const wood = [];
  const lean = 0.06 + rand() * 0.16, la = rand() * Math.PI * 2;
  const at = (t) => new THREE.Vector3(Math.cos(la) * lean * t * t, t * 0.86, Math.sin(la) * lean * t * t);
  const segs = 14;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs, t1 = (k + 1) / segs;
    // 曲がった幹の継ぎ目は外側に隙間が開いて空が透け、白い輪に見えた。次の節へ少し食い込ませてふさぐ
    wood.push(tint(limb(at(t0), at(Math.min(1, t1 + 0.02)), 0.026 - t0 * 0.008, 0.026 - t1 * 0.008, 7), k % 2 ? 0.85 : 1.05));
  }
  const top = at(1);
  const leaves = new Leaves();
  const nF = 13 + Math.floor(rand() * 4);
  for (let f = 0; f < nF; f++) {
    const az = (f / nF) * Math.PI * 2 + rand() * 0.4;
    const el = (rand() < 0.3 ? 0.7 : 0.25) + rand() * 0.35; // 若い葉は立ち、古い葉は垂れる
    const L = 0.32 + rand() * 0.12;
    const h = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-h.z, 0, h.x);
    const pt = (t) => top.clone().addScaledVector(h, L * t * Math.cos(el)).add(new THREE.Vector3(0, L * (t * Math.sin(el) - t * t * 0.55), 0));
    const nl = 26;
    for (let i = 2; i < nl; i++) {
      const t = i / nl;
      const c = pt(t);
      const tang = pt(Math.min(1, t + 0.02)).sub(pt(Math.max(0, t - 0.02))).normalize();
      const ll = 0.085 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)) + 0.015;
      for (const sg of [-1, 1]) {
        // 小葉は横へ出て、少し垂れる
        const d = side.clone().multiplyScalar(sg).addScaledVector(tang, 0.5).add(new THREE.Vector3(0, -0.35, 0)).normalize();
        const n = new THREE.Vector3().crossVectors(d, tang).normalize();
        if (n.y < 0) n.negate();
        const v = 0.7 + rand() * 0.35 - t * 0.1;
        leaves.add(c.clone().addScaledVector(d, ll / 2), d, n, ll, 0.012, v, n, (rand() - 0.3) * 1.2);
      }
    }
  }
  return { trunk: mergeGeometries(wood), crown: leaves.geometry() };
}

// 熱帯の下草：根元から広がる幅広の葉の株（ブロメリアやクワズイモのような）。葉は先へ細り、外へ反る
export function detailedTropicalPlant(seed = 1) {
  const rand = mulberry32(seed * 211 + 7);
  const pos = [], nrm = [], col = [];
  const n = 9 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rand() * 0.6;
    const el = 0.5 + rand() * 0.7;
    const L = 0.55 + rand() * 0.45, W = 0.07 + rand() * 0.08;
    const h = new THREE.Vector3(Math.cos(az), 0, Math.sin(az));
    const side = new THREE.Vector3(-h.z, 0, h.x);
    const pt = (t) => new THREE.Vector3().addScaledVector(h, L * t * Math.cos(el)).setY(L * (t * Math.sin(el) - t * t * 0.45));
    const segs = 6;
    const v = 0.75 + rand() * 0.4;
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs, t1 = (k + 1) / segs;
      const w0 = W * Math.sin(Math.PI * Math.min(1, t0 * 0.85 + 0.12)), w1 = W * Math.sin(Math.PI * Math.min(1, t1 * 0.85 + 0.12));
      const a = pt(t0), b = pt(t1);
      const tang = b.clone().sub(a).normalize();
      const nn = new THREE.Vector3().crossVectors(side, tang).normalize();
      if (nn.y < 0) nn.negate();
      // 葉の中央の筋で少し折る
      const fold = nn.clone().multiplyScalar(-0.25);
      const quad = [
        [a, 0], [a.clone().addScaledVector(side, w0).addScaledVector(fold, w0), 1], [b.clone().addScaledVector(side, w1).addScaledVector(fold, w1), 1],
        [a, 0], [b.clone().addScaledVector(side, w1).addScaledVector(fold, w1), 1], [b, 0],
        [a, 0], [b, 0], [b.clone().addScaledVector(side, -w1).addScaledVector(fold, w1), 1],
        [a, 0], [b.clone().addScaledVector(side, -w1).addScaledVector(fold, w1), 1], [a.clone().addScaledVector(side, -w0).addScaledVector(fold, w0), 1],
      ];
      for (const [p, e] of quad) {
        pos.push(p.x, p.y, p.z);
        nrm.push(nn.x, nn.y, nn.z);
        const c = v * (0.55 + 0.5 * (t0 + t1) / 2) * (1 - e * 0.08);
        col.push(c * 0.95, c, c * 0.8);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
