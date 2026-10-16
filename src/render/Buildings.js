import * as THREE from 'three';
import { aeqdInverse } from '../core/geo.js';

// 地球から取り込んだ景観の建物（OpenFreeMap のベクトルタイル。© OpenMapTiles © OpenStreetMap contributors）。
// カメラが地面から 2 km より低いとき、カメラの近く（約 1.4 km）のタイル（z14）だけ取り寄せて立体にする。
// 地面の高さは建物ごとに中心で測って足す（少し埋めて、斜面でも浮かないように）。
const Z = 14;
const NEAR = 1000; // この距離のタイルまで
const MAX_TILES = 4;
export const BUILDINGS_ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors（OpenFreeMap）';

export class Buildings {
  constructor(parent, patchMaterial) {
    this.group = new THREE.Group();
    this.group.name = 'Buildings';
    parent.add(this.group);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    patchMaterial?.(this.material);
    // 夜の窓の明かり：壁を階（3.2 m）と窓（3.5 m）の升目に分け、ところどころの窓を灯す
    this.night = { value: 0 };
    const prev = this.material.onBeforeCompile;
    this.material.onBeforeCompile = (sh, r) => {
      prev?.call(this.material, sh, r);
      sh.uniforms.bNight = this.night;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vBPos;
varying vec3 vBNrm;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vBPos = position;
vBNrm = normal;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform float bNight;
varying vec3 vBPos;
varying vec3 vBNrm;
float bHash( vec3 p ) { p = fract( p * 0.1031 ); p += dot( p, p.yzx + 33.33 ); return fract( ( p.x + p.y ) * p.z ); }`)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          if ( bNight > 0.0 && abs( vBNrm.y ) < 0.5 ) {
            float along = abs( vBNrm.x ) > abs( vBNrm.z ) ? vBPos.z : vBPos.x;
            vec2 cell = vec2( along / 3.5, vBPos.y / 3.2 );
            vec2 f = fract( cell );
            float win = step( 0.22, f.x ) * step( f.x, 0.78 ) * step( 0.3, f.y ) * step( f.y, 0.8 );
            vec3 id = vec3( floor( cell ), floor( dot( vBNrm.xz, vec2( 13.1, 7.7 ) ) ) );
            float on = step( 0.55, bHash( id ) );
            vec3 warm = mix( vec3( 1.0, 0.78, 0.48 ), vec3( 0.85, 0.9, 1.0 ), step( 0.85, bHash( id + 3.7 ) ) );
            totalEmissiveRadiance += warm * win * on * bNight;
          }`,
        );
    };
    this.material.customProgramCacheKey = () => 'buildings-night';
    this.tiles = new Map(); // "x/y" → { mesh, used, state }
    this.worker = null;
    this.urlTemplate = null;
    this.geoKey = null;
  }

  async #template() {
    if (this.urlTemplate !== null) return this.urlTemplate;
    this.urlTemplate = '';
    try {
      const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
      this.urlTemplate = tj.tiles?.[0] ?? '';
    } catch {
      this.urlTemplate = null; // あとでもう一度
    }
    return this.urlTemplate;
  }

  #clear() {
    for (const t of this.tiles.values()) if (t.mesh) (this.group.remove(t.mesh), t.mesh.geometry.dispose());
    this.tiles.clear();
  }

  // 夜の窓の明かりの強さ（0 = 昼）
  setNight(k) {
    this.night.value = k;
  }

  // s: シーン、cam: カメラ（世界座標・平らな地図の上）、groundAt(x, z)
  update(s, cam, groundAt) {
    const t = s.terrain;
    const geo = t.mode === 'heightmap' && t.buildings !== false ? t.heightmap?.geo : null;
    const key = geo ? `${t.heightmap.id}` : null;
    if (key !== this.geoKey) {
      this.#clear();
      this.geoKey = key;
    }
    this.group.visible = !!geo;
    if (!geo) return;
    const above = cam.y - groundAt(cam.x, cam.z);
    if (above > 2000) {
      this.group.visible = false;
      return;
    }
    if (Math.abs(cam.x) > t.size / 2 || Math.abs(cam.z) > t.size / 2) return;
    this.frame = (this.frame ?? 0) + 1;
    if (this.frame % 15) return; // 取り寄せる所の見直しは時々でよい
    // カメラの経緯度 → z14 のタイル
    const ll = aeqdInverse(cam.x, -cam.z, geo.lat, geo.lon);
    const n = 2 ** Z;
    const fx = ((ll.lon + 180) / 360) * n;
    const la = (ll.lat * Math.PI) / 180;
    const fy = ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n;
    const tileM = (2 * Math.PI * 6371000 * Math.cos(la)) / n;
    const r = Math.ceil(NEAR / tileM);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = Math.floor(fx) + dx, ty = Math.floor(fy) + dy;
        // タイルの中心までの距離で選ぶ
        const ddx = (tx + 0.5 - fx) * tileM, ddy = (ty + 0.5 - fy) * tileM;
        if (Math.hypot(ddx, ddy) > NEAR + tileM * 0.7) continue;
        const k = `${tx}/${ty}`;
        const tile = this.tiles.get(k);
        if (tile) {
          tile.used = this.frame;
          continue;
        }
        this.#request(tx, ty, k, geo, groundAt);
      }
    }
    // 遠くなったタイルを片付ける
    if (this.tiles.size > MAX_TILES) {
      const list = [...this.tiles.entries()].filter(([, v]) => v.state === 'ready').sort((a, b) => a[1].used - b[1].used);
      for (const [k, v] of list.slice(0, this.tiles.size - MAX_TILES)) {
        this.group.remove(v.mesh);
        v.mesh.geometry.dispose();
        this.tiles.delete(k);
      }
    }
  }

  // 歩くときに建物の壁で押し戻す（p: 足元〜目の高さの位置。body: 体の半径）
  pushOut(p, body = 0.35) {
    if (!this.group.visible) return false;
    let hit = false;
    const key = `${Math.floor(p.x / 50)},${Math.floor(p.z / 50)}`;
    for (const t of this.tiles.values()) {
      const list = t.hit?.cells.get(key);
      if (!list) continue;
      const { ring, ringStart, top } = t.hit;
      for (const b of list) {
        if (p.y > top[b] + 1.7) continue; // 屋根より上にいる（飛んでいる）
        const s = ringStart[b], e = ringStart[b + 1];
        // 外形の内側か（交差の数）と、いちばん近い壁の点
        let inside = false, best = Infinity, bx = 0, bz = 0;
        for (let q = s, r = e - 1; q < e; r = q++) {
          const ax = ring[r * 2], az = ring[r * 2 + 1], cx = ring[q * 2], cz = ring[q * 2 + 1];
          if (az > p.z !== cz > p.z && p.x < ((cx - ax) * (p.z - az)) / (cz - az) + ax) inside = !inside;
          const dx = cx - ax, dz = cz - az, l2 = dx * dx + dz * dz || 1;
          const f = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
          const nx = ax + dx * f, nz = az + dz * f, d = Math.hypot(p.x - nx, p.z - nz);
          if (d < best) (best = d), (bx = nx), (bz = nz);
        }
        if (!inside && best >= body) continue;
        // 壁の外側へ、体の半径だけ離す
        let ox = p.x - bx, oz = p.z - bz;
        const l = Math.hypot(ox, oz) || 1;
        if (inside) (ox = -ox), (oz = -oz);
        p.x = bx + (ox / l) * body;
        p.z = bz + (oz / l) * body;
        hit = true;
      }
    }
    return hit;
  }

  async #request(tx, ty, k, geo, groundAt) {
    const tile = { state: 'loading', used: this.frame, mesh: null };
    this.tiles.set(k, tile);
    const tpl = await this.#template();
    if (!tpl) return this.tiles.delete(k);
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/buildingWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.#receive(e.data);
    }
    tile.groundAt = groundAt;
    this.worker.postMessage({ key: `${this.geoKey}|${k}`, url: tpl.replace('{z}', Z).replace('{x}', tx).replace('{y}', ty), z: Z, x: tx, y: ty, geo: { lat: geo.lat, lon: geo.lon } });
  }

  #receive(m) {
    const [gk, k] = m.key.split('|');
    const tile = this.tiles.get(k);
    if (gk !== this.geoKey || !tile) return;
    if (m.error || !m.count) {
      tile.state = 'ready';
      tile.mesh = new THREE.Object3D();
      return;
    }
    // 建物ごとの地面の高さ（中心で測り、2 m 埋める）を足す
    const base = new Float32Array(m.count);
    for (let b = 0; b < m.count; b++) base[b] = tile.groundAt(m.centers[b * 2], m.centers[b * 2 + 1]) - 2;
    const p = m.positions;
    for (let v = 0; v < m.ids.length; v++) p[v * 3 + 1] += base[m.ids[v]] + (p[v * 3 + 1] === 0 ? 0 : 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.castShadow = false; // 影の地図に描くと重い（地面への影は省く）
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // 丸みで曲げるので、元の位置での判定は使えない
    this.group.add(mesh);
    tile.mesh = mesh;
    tile.state = 'ready';
    // ぶつかる判定用：建物の外形を 50 m の升目に振り分けておく
    const cells = new Map();
    for (let b = 0; b < m.count; b++) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let q = m.ringStart[b]; q < m.ringStart[b + 1]; q++) {
        const x = m.ring[q * 2], z = m.ring[q * 2 + 1];
        x0 = Math.min(x0, x), x1 = Math.max(x1, x), z0 = Math.min(z0, z), z1 = Math.max(z1, z);
      }
      for (let i = Math.floor(x0 / 50); i <= Math.floor(x1 / 50); i++) {
        for (let j = Math.floor(z0 / 50); j <= Math.floor(z1 / 50); j++) {
          const k2 = `${i},${j}`;
          if (!cells.has(k2)) cells.set(k2, []);
          cells.get(k2).push(b);
        }
      }
    }
    tile.hit = { cells, ring: m.ring, ringStart: m.ringStart, top: m.tops.map((h, b) => base[b] + 2 + h) };
  }
}
