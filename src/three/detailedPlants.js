import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

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
export function detailedBroadleaf(seed = 1) {
  const rand = mulberry32(seed * 7919 + 13);
  const wood = [];
  const leaves = new Leaves();
  const crownC = new THREE.Vector3(0, 0.66, 0);
  const trunkTop = new THREE.Vector3((rand() - 0.5) * 0.04, 0.42 + rand() * 0.06, (rand() - 0.5) * 0.04);
  wood.push(limb(new THREE.Vector3(0, -0.02, 0), trunkTop, 0.034, 0.024, 8));
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
      leaves.add(lc, ld, n, 0.022 + rand() * 0.01, 0.012 + rand() * 0.006, v, lo.clone().lerp(out, 0.5).normalize(), (rand() - 0.5) * 2);
    }
  }
  return {
    trunk: tint(mergeGeometries(wood), 1),
    crown: leaves.geometry(),
  };
}

// 針葉樹：まっすぐな幹と、下ほど長く垂れる枝の段。枝に沿って針葉の房のカード
export function detailedConifer(seed = 1) {
  const rand = mulberry32(seed * 104729 + 7);
  const wood = [limb(new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(0, 0.97, 0), 0.026, 0.004, 7)];
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
      if (len > 0.08) wood.push(limb(s, e, 0.004, 0.0015, 4));
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
  return { trunk: tint(mergeGeometries(wood), 1), crown: leaves.geometry() };
}

// 草の株：細い葉を 48 本ほど、幅 0.5 ほどに広げる（根元は暗く先は明るい）
export function detailedGrass(seed = 1) {
  const rand = mulberry32(seed * 31 + 5);
  const pos = [], nrm = [], col = [];
  for (let i = 0; i < 48; i++) {
    const a = rand() * Math.PI * 2;
    const r0 = Math.sqrt(rand()) * 0.24;
    const bx = Math.cos(a) * r0, bz = Math.sin(a) * r0;
    const lean = 0.08 + rand() * 0.45;
    const la = a + (rand() - 0.5) * 1.2;
    const h = 0.45 + rand() * 0.6;
    const w = 0.012 + rand() * 0.01;
    const segs = 4;
    const v = 0.75 + rand() * 0.5;
    const pts = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const off = lean * t * t * h;
      pts.push([bx + Math.cos(la) * off, t * h * (1 - lean * t * 0.25), bz + Math.sin(la) * off, w * (1 - t * 0.95), t]);
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
        // 法線は上寄り（草原がふんわり明るく見える）
        nrm.push(Math.cos(la) * 0.3, 0.9, Math.sin(la) * 0.3);
        const c = v * (0.45 + 0.75 * t); // 根元は陰で暗く、先は明るい
        col.push(c * (1 + t * 0.12), c, c * (1 - t * 0.15));
      }
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
  const g = new THREE.IcosahedronGeometry(0.5, 4);
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
  return g;
}
