import * as THREE from 'three';

// 雨と雪：カメラの周りの箱（60 × 40 × 60 m）の中だけに降らせ、箱の外へ出たら反対側から戻す（どこへ行っても降り続く）。
// 雨は細い線、雪は点。風で少し流れる。カメラについて動かすので、丸みや原点のずらしとは関係しない。
const BOX = [60, 40, 60];
const N_RAIN = 7000, N_SNOW = 5000;

export class Precipitation {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Precipitation';
    this.group.frustumCulled = false;
    scene.add(this.group);
    this.kind = 'none';
    this.t = 0;
    const rnd = (n, k) => {
      const a = new Float32Array(n * k);
      for (let i = 0; i < a.length; i++) a[i] = Math.random();
      return a;
    };
    // 雨：線分（上端と下端）。位置は 0..1 の乱数を毎コマ箱の大きさへ
    this.rainSeed = rnd(N_RAIN, 3);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_RAIN * 6), 3));
    this.rain = new THREE.LineSegments(
      rg,
      new THREE.LineBasicMaterial({ color: 0xaab4c4, transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false, fog: false }),
    );
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    // 雪：点
    this.snowSeed = rnd(N_SNOW, 4);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_SNOW * 3), 3));
    this.snow = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xf2f6fb, size: 0.17, sizeAttenuation: true, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false, fog: false }),
    );
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.group.add(this.rain, this.snow);
  }

  set(kind) {
    this.kind = kind ?? 'none';
    this.rain.visible = this.kind === 'rain';
    this.snow.visible = this.kind === 'snow';
  }

  // at: いま描くカメラの位置（箱の中心）、ref: カメラの世界座標（平らな地図の上。雨粒をその場に留めるため）、
  // light: 明るさ（夜は暗く。0..1）。時間は自分で測る
  update(at, ref, light = 1) {
    if (this.kind === 'none') return;
    const now = performance.now() / 1000;
    this.t += Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    this.group.position.copy(at);
    const [W, H, D] = BOX;
    // 箱の中の位置：カメラの世界座標に対して固定（カメラが動くと雨粒は後ろへ流れる）
    const ox = ref.x, oy = ref.y, oz = ref.z;
    const wrap = (v, size) => ((v % size) + size) % size - size / 2;
    if (this.kind === 'rain') {
      const p = this.rain.geometry.attributes.position.array, s = this.rainSeed;
      const fall = this.t * 9; // 雨の落ちる速さ 9 m/s
      const drift = this.t * 1.5;
      for (let i = 0; i < N_RAIN; i++) {
        const x = wrap(s[i * 3] * W + drift - ox, W), z = wrap(s[i * 3 + 2] * D - oz, D);
        const y = wrap(s[i * 3 + 1] * H - fall - oy, H);
        const k = i * 6;
        p[k] = x;
        p[k + 1] = y;
        p[k + 2] = z;
        p[k + 3] = x - 0.12;
        p[k + 4] = y - 0.55; // 雨の筋の長さ
        p[k + 5] = z;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.material.opacity = 0.35 * light;
    } else {
      const p = this.snow.geometry.attributes.position.array, s = this.snowSeed;
      const fall = this.t * 1.1; // 雪はゆっくり
      for (let i = 0; i < N_SNOW; i++) {
        // ひらひら：一つずつ違う揺れ
        const sway = Math.sin(this.t * (0.6 + s[i * 4 + 3]) + s[i * 4 + 3] * 20) * 0.6;
        const x = wrap(s[i * 4] * W + sway + this.t * 0.4 - ox, W), z = wrap(s[i * 4 + 2] * D + sway * 0.7 - oz, D);
        const y = wrap(s[i * 4 + 1] * H - fall - oy, H);
        p[i * 3] = x;
        p[i * 3 + 1] = y;
        p[i * 3 + 2] = z;
      }
      this.snow.geometry.attributes.position.needsUpdate = true;
      this.snow.material.opacity = 0.85 * light;
    }
  }
}
