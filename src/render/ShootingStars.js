import * as THREE from 'three';

// 流れ星：晴れた夜、ときどき（平均 15 秒に 1 つ）空の高い所をすっと流れる。
// 頭が明るく尾が消えていく線を、カメラの周り DIST m の所に描く（山より奥）。
const DIST = 70000;
const SEG = 24; // 尾の点の数

export class ShootingStars {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEG * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SEG * 3), 3));
    this.line = new THREE.Line(
      g,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.line.name = 'ShootingStar';
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.line.renderOrder = 1;
    scene.add(this.line);
    this.star = null;
    this.next = 4;
  }

  // at: カメラの描く位置、amount: 出しやすさ（0..1。夜で晴れているほど 1）、exposure: 露出
  update(at, amount, exposure) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    if (!this.star) {
      this.line.visible = false;
      if (amount < 0.05) return;
      this.next -= dt * amount;
      if (this.next > 0) return;
      this.next = 5 + Math.random() * 20;
      // 始まりの向き（高さ 25〜70°、方位は何でも）と流れる向き（おおむね下向きに斜め）
      const az = Math.random() * Math.PI * 2, el = THREE.MathUtils.degToRad(25 + Math.random() * 45);
      const start = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      const side = new THREE.Vector3().crossVectors(start, new THREE.Vector3(0, 1, 0)).normalize();
      const down = new THREE.Vector3().crossVectors(side, start).normalize().negate();
      const dir = down.multiplyScalar(0.5 + Math.random() * 0.4).addScaledVector(side, (Math.random() - 0.5) * 2).normalize();
      this.star = { start, dir, t: 0, dur: 0.5 + Math.random() * 0.7, len: THREE.MathUtils.degToRad(8 + Math.random() * 14), bright: 0.5 + Math.random() * 0.5 };
    }
    const s = this.star;
    s.t += dt;
    const k = s.t / s.dur;
    if (k >= 1) {
      this.star = null;
      this.line.visible = false;
      return;
    }
    // 頭の位置：始まりから流れる向きへ、角度で len だけ進む。尾は頭の後ろ 4 割ほど
    const pos = this.line.geometry.attributes.position.array;
    const col = this.line.geometry.attributes.color.array;
    const fade = Math.sin(Math.PI * Math.min(1, k * 1.2)); // 現れて消える
    const gain = (s.bright * fade * 1.5) / Math.max(0.02, exposure);
    const v = new THREE.Vector3();
    for (let i = 0; i < SEG; i++) {
      const u = i / (SEG - 1); // 0 = 頭、1 = 尾の端
      const a = Math.max(0, k - u * 0.4) * s.len;
      v.copy(s.start).multiplyScalar(Math.cos(a)).addScaledVector(s.dir, Math.sin(a)).normalize();
      pos[i * 3] = v.x * DIST;
      pos[i * 3 + 1] = v.y * DIST;
      pos[i * 3 + 2] = v.z * DIST;
      const b = gain * (1 - u) * (1 - u);
      col[i * 3] = b * 0.95;
      col[i * 3 + 1] = b * 0.97;
      col[i * 3 + 2] = b;
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.attributes.color.needsUpdate = true;
    this.line.position.copy(at);
    this.line.visible = true;
  }
}
