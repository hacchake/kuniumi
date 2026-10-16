import * as THREE from 'three';

// 雨と雪：カメラの周りの箱（60 × 40 × 60 m）の中だけに降らせ、箱の外へ出たら反対側から戻す（どこへ行っても降り続く）。
// 雨は細い線、雪は点。風で少し流れる。カメラについて動かすので、丸みや原点のずらしとは関係しない。
const BOX = [60, 40, 60];
const N_RAIN = 7000, N_SNOW = 5000, N_DROPS = 300;

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
    // 水しぶき：浅瀬を歩いたとき足元に飛ぶ粒（平らな地図の座標で持ち、重力で落ちて消える）
    this.drops = [];
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N_DROPS * 3), 3));
    // 丸いぼかした粒（四角い点にならないように）
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const cx = cv.getContext('2d');
    const gr = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.7)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = gr;
    cx.fillRect(0, 0, 32, 32);
    this.splashPts = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ color: 0xe8f0f6, map: new THREE.CanvasTexture(cv), size: 0.08, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
    );
    this.splashPts.frustumCulled = false;
    this.splashPts.visible = false;
    this.group.add(this.splashPts);
  }

  // 水しぶきの明るさ：景色は物理的な明るさで描いて後から露出をかけるので、露出の逆数ほど明るく（light = 昼夜）
  setSplashGain(exposure, light = 1) {
    this.splashPts.material.color.setRGB(0.9, 0.94, 0.96).multiplyScalar((0.8 / Math.max(0.02, exposure)) * light);
  }

  // 水しぶきを 1 回：at = 足元（平らな地図の座標）、dir = 進む向き（水平）、strength = 1 で 1 歩
  splash(at, dir, strength = 1) {
    const n = Math.round(40 * strength);
    for (let i = 0; i < n && this.drops.length < N_DROPS; i++) {
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.4;
      this.drops.push({
        x: at.x + (Math.random() - 0.5) * 0.3, y: at.y + 0.03, z: at.z + (Math.random() - 0.5) * 0.3,
        vx: Math.cos(a) * sp + dir.x * 1.2, vy: 1.5 + Math.random() * 2 * strength, vz: Math.sin(a) * sp + dir.z * 1.2,
        life: 0.5 + Math.random() * 0.4,
      });
    }
  }

  #updateDrops(dt, ref) {
    const p = this.splashPts.geometry.attributes.position.array;
    let k = 0;
    this.drops = this.drops.filter((d) => (d.life -= dt) > 0);
    for (const d of this.drops) {
      d.vy -= 9.8 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      p[k++] = d.x - ref.x;
      p[k++] = d.y - ref.y;
      p[k++] = d.z - ref.z;
    }
    this.splashPts.geometry.setDrawRange(0, this.drops.length);
    this.splashPts.geometry.attributes.position.needsUpdate = true;
    this.splashPts.visible = this.drops.length > 0;
  }

  set(kind) {
    this.kind = kind === 'storm' ? 'rain' : kind ?? 'none'; // 雷雨の雨はふつうの雨と同じ
    this.rain.visible = this.kind === 'rain';
    this.snow.visible = this.kind === 'snow';
  }

  // at: いま描くカメラの位置（箱の中心）、ref: カメラの世界座標（平らな地図の上。雨粒をその場に留めるため）、
  // light: 明るさ（夜は暗く。0..1）。時間は自分で測る
  update(at, ref, light = 1) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    this.group.position.copy(at);
    if (this.drops.length || this.splashPts.visible) this.#updateDrops(dt, ref);
    if (this.kind === 'none') return;
    this.t += dt;
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
