import * as THREE from 'three';

// 手彫りの筆：選んでいる間、画面を左ドラッグすると地形を盛る・削る・ならす（見回しは右ドラッグ・ホイール）。
// 筆の跡は terrain.sculpt に足していく（0.25 秒ごと・離したときにまとめて。元に戻すは 1 回のドラッグごと）。
// 地面の上には筆の大きさの輪を出す。
export class SculptTool {
  // pick(ndc) → 地面の点（平らな地図の座標）| null、world: 輪を置く親、controls: OrbitControls
  constructor({ canvas, store, controls, camera, world, pick, groundAt }) {
    Object.assign(this, { canvas, store, controls, camera, pick, groundAt });
    this.mode = null; // 'raise' | 'lower' | 'flat' | 'smooth' | 'plant' | 'clear' | null
    this.radius = 150; // m
    this.strength = 8; // 1 回のひと押しの高さ (m)
    this.pending = [];
    // 筆の輪
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    this.ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffd27a, depthTest: false, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    this.ring.renderOrder = 20;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    world.add(this.ring);
    this.#bind();
  }

  set(mode, { radius, strength } = {}) {
    this.mode = mode;
    if (radius) this.radius = radius;
    if (strength) this.strength = strength;
    // 左ドラッグは筆に使う（見回しは右ドラッグで）
    this.controls.mouseButtons.LEFT = mode ? null : THREE.MOUSE.ROTATE;
    this.controls.mouseButtons.RIGHT = mode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.canvas.style.cursor = mode ? 'crosshair' : '';
    if (!mode) this.ring.visible = false;
  }

  #ndc(e) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  #showRing(p) {
    if (!p) return (this.ring.visible = false);
    this.ring.position.set(p.x, this.groundAt(p.x, p.z) + 2, p.z);
    this.ring.scale.setScalar(this.radius);
    this.ring.material.color.set(this.mode === 'lower' ? 0x8ad0ff : this.mode === 'flat' ? 0xb8f0a0 : this.mode === 'smooth' ? 0xe0b8ff : this.mode === 'plant' ? 0x6ee07a : this.mode === 'clear' ? 0xff8a6a : 0xffd27a);
    this.ring.visible = true;
  }

  #stamp(p) {
    const r = this.radius;
    if (this.mode === 'flat') this.pending.push({ x: round(p.x), z: round(p.z), r: round(r), flat: round(this.flatTo), k: 0.35 });
    else if (this.mode === 'smooth') this.pending.push({ x: round(p.x), z: round(p.z), r: round(r), smooth: 0.6 });
    else if (this.mode === 'plant' || this.mode === 'clear') this.pending.push({ x: round(p.x), z: round(p.z), r: round(r), v: this.mode === 'plant' ? 1 : -1 });
    else this.pending.push({ x: round(p.x), z: round(p.z), r: round(r), h: round(this.mode === 'lower' ? -this.strength : this.strength) });
    this.last = p;
  }

  #commit() {
    if (!this.pending.length) return;
    // 森の筆は植生へ、ほかは地形へ
    const path = this.mode === 'plant' || this.mode === 'clear' ? 'vegetation.paint' : 'terrain.sculpt';
    const cur = path === 'vegetation.paint' ? this.store.get().vegetation.paint ?? [] : this.store.get().terrain.sculpt ?? [];
    this.store.set(path, [...cur, ...this.pending], { source: 'sculpt' });
    this.pending = [];
  }

  #bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.mode || e.button !== 0) return;
      const p = this.pick(this.#ndc(e));
      if (!p) return;
      this.drawing = true;
      try {
        c.setPointerCapture(e.pointerId);
      } catch {}
      this.flatTo = this.groundAt(p.x, p.z); // ならす：押した所の高さへ
      this.#stamp(p);
      this.timer = setInterval(() => this.#commit(), 250);
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.mode) return;
      const p = this.pick(this.#ndc(e));
      this.#showRing(p);
      // 筆の半径の 1/4 進むごとにひと押し
      if (this.drawing && p && Math.hypot(p.x - this.last.x, p.z - this.last.z) > this.radius * 0.25) this.#stamp(p);
    });
    const end = () => {
      if (!this.drawing) return;
      this.drawing = false;
      clearInterval(this.timer);
      this.#commit();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => !this.drawing && (this.ring.visible = false));
  }
}

const round = (v) => Math.round(v * 10) / 10;
