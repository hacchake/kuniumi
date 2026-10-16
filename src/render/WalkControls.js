import * as THREE from 'three';

// 歩き回るモード（一人称）。地面に沿って歩くか、自由に飛ぶ。
//   W/A/S/D・矢印：移動　マウス：見回す（画面をクリックするとカーソルを隠して見回せる）
//   Space：ジャンプ（飛行中は上昇）　C / Ctrl：下降（飛行中）　Shift：走る・速く飛ぶ
//   F：歩く ⇔ 飛ぶ　ホイール：速さ　Esc：元の見回しへ戻る
// 飛行の速さは地面からの高さに比例させるので、足元の小川から大陸の上空まで同じ感覚で動ける。
// 座標は平らな地図のまま（丸みは描くときに曲げる）。

const EYE = 1.65; // 目の高さ (m)
const WALK = 1.5; // 歩く速さ (m/s)
const GRAVITY = 9.8;
const JUMP = 4.6;
const LOOK = 0.0022; // マウス 1 画素あたりの回転 (rad)

export class WalkControls {
  // groundAt(x, z): 足元の高さ（地形と水面の高い方）
  // collide(p): 木などに当たったら位置を押し戻す（歩くときだけ）
  constructor(camera, canvas, { groundAt, onModeChange, collide }) {
    this.collide = collide ?? null;
    this.camera = camera;
    this.canvas = canvas;
    this.groundAt = groundAt;
    this.onModeChange = onModeChange ?? (() => {});
    this.active = false;
    this.mode = 'walk';
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.vy = 0;
    this.grounded = false;
    this.speedScale = 1;
    this.drag = null;
    this.#bind();
  }

  enter(mode = 'walk') {
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-fwd.x, -fwd.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    this.mode = mode;
    this.vy = 0;
    this.keys.clear();
    this.active = true;
    // 歩くときは足元へ降ろす
    if (mode === 'walk') {
      const p = this.camera.position;
      p.y = this.groundAt(p.x, p.z) + EYE;
      this.grounded = true;
    }
    this.onModeChange(this.mode);
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.keys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.onModeChange(null);
  }

  toggleMode() {
    this.mode = this.mode === 'walk' ? 'fly' : 'walk';
    this.vy = 0;
    this.onModeChange(this.mode);
  }

  // 見ている向き（単位ベクトル）
  forward(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  update(dt) {
    if (!this.active) return false;
    dt = Math.min(dt, 0.1);
    const cam = this.camera;
    const p = cam.position;
    const k = this.keys;
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const ix = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const iz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const ground = this.groundAt(p.x, p.z);
    const fwdFlat = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    if (this.mode === 'fly') {
      // 高いほど速く（地面から 10 m で約 8 m/s、1000 km 上空で約 80 万 m/s）
      const above = Math.max(2, p.y - ground);
      const v = Math.max(8, above * 0.8) * this.speedScale * (run ? 5 : 1);
      const dir = this.forward().multiplyScalar(iz).addScaledVector(right, ix);
      const iy = (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyC') || k.has('ControlLeft') || k.has('KeyQ') ? 1 : 0);
      dir.y += iy;
      if (dir.lengthSq() > 0) p.addScaledVector(dir.normalize(), v * dt);
      const floor = this.groundAt(p.x, p.z) + EYE;
      if (p.y < floor) p.y = floor;
    } else {
      const v = WALK * this.speedScale * (run ? 4 : 1);
      const dir = fwdFlat.multiplyScalar(iz).addScaledVector(right, ix);
      if (dir.lengthSq() > 0) p.addScaledVector(dir.normalize(), v * dt);
      this.collide?.(p);
      // 重力とジャンプ
      if (k.has('Space') && this.grounded) {
        this.vy = JUMP;
        this.grounded = false;
      }
      this.vy -= GRAVITY * dt;
      p.y += this.vy * dt;
      const floor = this.groundAt(p.x, p.z) + EYE;
      if (p.y <= floor) {
        // 坂道や段差は足元に合わせる（高い所から落ちたときも着地）
        p.y = floor;
        this.vy = 0;
        this.grounded = true;
      } else if (p.y - floor < 0.25 && this.vy <= 0) {
        // 下り坂ではそのまま地面に沿う
        p.y = floor;
        this.vy = 0;
        this.grounded = true;
      } else {
        this.grounded = false;
      }
    }
    cam.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    cam.updateMatrixWorld();
    return true;
  }

  #bind() {
    const c = this.canvas;
    const look = (dx, dy) => {
      this.yaw -= dx * LOOK;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK, -1.55, 1.55);
    };
    c.addEventListener('click', () => {
      if (this.active && document.pointerLockElement !== c) c.requestPointerLock?.()?.catch?.(() => {});
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (document.pointerLockElement === c) look(e.movementX, e.movementY);
      else if (this.drag) {
        look(e.clientX - this.drag.x, e.clientY - this.drag.y);
        this.drag = { x: e.clientX, y: e.clientY };
      }
    });
    // カーソルを隠せないときは、ドラッグで見回す
    c.addEventListener('pointerdown', (e) => {
      if (this.active && document.pointerLockElement !== c) this.drag = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => (this.drag = null));
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.speedScale = THREE.MathUtils.clamp(this.speedScale * (e.deltaY > 0 ? 0.8 : 1.25), 0.05, 50);
        this.onModeChange(this.mode);
      },
      { passive: false, capture: true },
    );
    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
      if (e.code === 'KeyF' && !e.repeat) this.toggleMode();
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
}
