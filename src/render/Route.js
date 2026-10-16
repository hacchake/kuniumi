import * as THREE from 'three';

// 読み込んだ経路（GPX）：地面に沿った幅 WIDTH m の帯を、地面から少し浮かせて描く（夜も見えるよう少し光る）。
// 点は最初の点を原点にした相対で持つ（遠い所でも揺れないように）。間が長い所は STEP m ごとに地面の高さを拾う。
const WIDTH = 2.5;
const STEP = 8;

export class Route {
  constructor(parent, patchMaterial) {
    this.parent = parent;
    this.material = new THREE.MeshStandardMaterial({
      color: 0xff7a3c,
      emissive: 0xff5a1c,
      emissiveIntensity: 0.6,
      roughness: 0.8,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    patchMaterial?.(this.material);
    this.mesh = null;
  }

  // pts: [{ x, z }]（平らな地図の座標）、groundAt(x, z): 地面の高さ。null で消す
  set(pts, groundAt) {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
      this.mesh = null;
    }
    if (!pts || pts.length < 2) return;
    // 細かく分けた中心線
    const line = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / STEP));
      for (let k = 0; k < n; k++) line.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    }
    line.push(pts[pts.length - 1]);
    const o = line[0];
    const pos = new Float32Array(line.length * 2 * 3);
    const idx = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i], q = line[Math.min(line.length - 1, i + 1)], r = line[Math.max(0, i - 1)];
      let dx = q.x - r.x, dz = q.z - r.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      // 進む向きに直交する左右
      const nx = -dz * (WIDTH / 2), nz = dx * (WIDTH / 2);
      for (let s = 0; s < 2; s++) {
        const x = p.x + (s ? nx : -nx), z = p.z + (s ? nz : -nz);
        const j = (i * 2 + s) * 3;
        pos[j] = x - o.x;
        pos[j + 1] = groundAt(x, z) + 1.0; // 地形の細かい起伏に潜らないよう少し浮かせる
        pos[j + 2] = z - o.z;
      }
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.name = 'Route';
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.position.set(o.x, 0, o.z);
    this.parent.add(this.mesh);
  }
}
