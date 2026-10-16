import * as THREE from 'three';
import { t } from '../i18n/index.js';

// 歩き回るモード（一人称）。地面に沿って歩くか、自由に飛ぶ。
//   W/A/S/D・矢印：移動　マウス：見回す（画面をクリックするとカーソルを隠して見回せる）
//   Space：ジャンプ（飛行中は上昇）　C / Ctrl：下降（飛行中）　Shift：走る・速く飛ぶ
//   F：歩く ⇔ 飛ぶ　ホイール：速さ　Esc：元の見回しへ戻る
// 飛行の速さは地面からの高さに比例させるので、足元の小川から大陸の上空まで同じ感覚で動ける。
// 座標は平らな地図のまま（丸みは描くときに曲げる）。
// タブレット・スマートフォン：左下のスティックで移動、画面をなぞって見回す、右下のボタンでジャンプ・上昇／下降・走る・歩く⇔飛ぶ。

const EYE = 1.65; // 目の高さ (m)
const WALK = 1.5; // 歩く速さ (m/s)
const GRAVITY = 9.8;
const JUMP = 4.6;
const LOOK = 0.0022; // マウス 1 画素あたりの回転 (rad)

export class WalkControls {
  // groundAt(x, z): 足元の高さ（地形と水面の高い方）
  // collide(p): 木などに当たったら位置を押し戻す（歩くときだけ）
  constructor(camera, canvas, { groundAt, onModeChange, collide, isDeep }) {
    this.collide = collide ?? null;
    this.isDeep = isDeep ?? null; // 深い水の上か（そこでは小舟に乗って揺れる）
    this.bobY = 0;
    this.boatT = 0;
    this.camera = camera;
    this.canvas = canvas;
    this.groundAt = groundAt;
    const cb = onModeChange ?? (() => {});
    this.onModeChange = (m) => {
      this.syncTouchUI?.();
      cb(m);
    };
    this.active = false;
    this.mode = 'walk';
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.vy = 0;
    this.grounded = false;
    this.speedScale = 1;
    this.drag = null;
    this.stick = { x: 0, y: 0 }; // 画面のスティック（−1..1、上 = 前）
    this.touchKeys = new Set(); // 画面のボタンで押している「キー」
    this.run = false; // 画面の「走る」ボタン（押すたびに切り替え）
    this.#bind();
    this.#buildTouchUI();
  }

  enter(mode = 'walk') {
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    this.yaw = Math.atan2(-fwd.x, -fwd.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    this.mode = mode;
    this.vy = 0;
    this.flyVel = new THREE.Vector3(); // 飛ぶときの動き（向き×速さの割合）。慣性でなめらかに
    this.keys.clear();
    this.touchKeys.clear();
    this.stick.x = this.stick.y = 0;
    this.active = true;
    // 双眼鏡（Z キー・画面の「望遠」）：視野を 1/6 に。入ったときの視野を覚えておく
    this.baseFov = this.camera.fov;
    this.setZoom(false);
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
    this.touchKeys.clear();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.setZoom(false);
    if (this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
    this.onModeChange(null);
  }

  setZoom(on) {
    this.zoom = on;
    this.binoc?.toggleAttribute('hidden', !on);
    this.touchUI?.querySelector('[data-zoom]')?.classList.toggle('on', on);
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
    const k = { has: (c) => this.keys.has(c) || this.touchKeys.has(c) };
    const run = k.has('ShiftLeft') || k.has('ShiftRight') || this.run;
    // キーと画面のスティック（スティックは倒した分だけの速さ）
    let ix = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + this.stick.x;
    let iz = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + this.stick.y;
    const il = Math.hypot(ix, iz);
    if (il > 1) (ix /= il), (iz /= il);
    // 前のコマの舟の揺れ（上下）を外してから動かす
    p.y -= this.bobY;
    this.bobY = 0;
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
      if (dir.lengthSq() > 1) dir.normalize();
      // 慣性：押した向きへ約 0.3 秒でなじみ、離すとすっと止まる（急に止まらない）
      this.flyVel ??= new THREE.Vector3();
      this.flyVel.lerp(dir, 1 - Math.exp(-dt / (dir.lengthSq() > 0 ? 0.3 : 0.4)));
      if (this.flyVel.lengthSq() < 1e-6) this.flyVel.set(0, 0, 0);
      else p.addScaledVector(this.flyVel, v * dt);
      const floor = this.groundAt(p.x, p.z) + EYE;
      if (p.y < floor) p.y = floor;
    } else {
      const v = WALK * this.speedScale * (run ? 4 : 1);
      const dir = fwdFlat.multiplyScalar(iz).addScaledVector(right, ix);
      if (dir.lengthSq() > 1) dir.normalize();
      if (dir.lengthSq() > 0) p.addScaledVector(dir, v * dt);
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
    // 望遠：視野をなめらかに狭める・戻す
    if (this.baseFov) {
      const want = this.zoom ? this.baseFov / 6 : this.baseFov;
      if (Math.abs(cam.fov - want) > 0.01) {
        cam.fov += (want - cam.fov) * Math.min(1, dt * 8);
        cam.updateProjectionMatrix();
      }
    }
    // 小舟：深い水の上では、波でゆっくり上下・左右に揺れる（座った目の高さ）
    this.boating = this.mode === 'walk' && !!this.isDeep?.(p.x, p.z);
    this.boatT += dt;
    let roll = 0, pitchOff = 0;
    if (this.boating) {
      const t = this.boatT;
      this.bobY = 0.1 * Math.sin(t * 1.3) + 0.04 * Math.sin(t * 2.2 + 1.0) - 0.55;
      roll = 0.035 * Math.sin(t * 1.05) + 0.015 * Math.sin(t * 1.9 + 2.0);
      pitchOff = 0.02 * Math.sin(t * 1.5 + 0.7);
      p.y += this.bobY;
    }
    this.boatRoll = roll;
    this.boatPitch = pitchOff;
    cam.quaternion.setFromEuler(new THREE.Euler(this.pitch + pitchOff, this.yaw, roll, 'YXZ'));
    cam.updateMatrixWorld();
    return true;
  }

  #bind() {
    const c = this.canvas;
    const look = (dx, dy) => {
      // 望遠のときは、視野の狭さに合わせてゆっくり見回す
      const k = this.baseFov ? this.camera.fov / this.baseFov : 1;
      this.yaw -= dx * LOOK * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * LOOK * k, -1.55, 1.55);
    };
    c.addEventListener('click', (e) => {
      // 指で触る端末ではカーソルを隠さない
      if (this.active && document.pointerLockElement !== c && e.pointerType !== 'touch' && !this.touchUsed) c.requestPointerLock?.()?.catch?.(() => {});
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') this.touchUsed = true;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      if (document.pointerLockElement === c) look(e.movementX, e.movementY);
      else if (this.drag && !this.drag.touch) {
        look(e.clientX - this.drag.x, e.clientY - this.drag.y);
        this.drag = { x: e.clientX, y: e.clientY };
      }
    });
    // カーソルを隠せないとき・指で触るときは、なぞって見回す
    c.addEventListener('pointerdown', (e) => {
      if (this.active && document.pointerLockElement !== c) this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === 'touch' };
    });
    document.addEventListener('pointermove', (e) => {
      // 指は pointermove で（mousemove が来ない端末がある）。複数の指のうち、見回しに使っている指だけ
      if (!this.active || !this.drag?.touch || e.pointerId !== this.drag.id) return;
      look(e.clientX - this.drag.x, e.clientY - this.drag.y);
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    });
    window.addEventListener('pointerup', (e) => {
      if (!this.drag || e.pointerId === this.drag.id || !this.drag.touch) this.drag = null;
    });
    window.addEventListener('pointercancel', (e) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    });
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
      if (e.code === 'KeyZ' && !e.repeat) this.setZoom(!this.zoom);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---- 画面の操作部品（指で触る端末だけ） ----
  #buildTouchUI() {
    const host = this.canvas.parentElement;
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'walk-touch';
    el.hidden = true;
    el.innerHTML = `
      <div class="walk-stick" aria-label="移動"><div class="walk-knob"></div></div>
      <div class="walk-btns">
        <button type="button" data-k="Space" data-hold>ジャンプ</button>
        <button type="button" data-k="KeyC" data-hold data-fly>下降</button>
        <button type="button" data-run>走る</button>
        <button type="button" data-mode>飛行モード</button>
        <button type="button" data-zoom>望遠</button>
      </div>`;
    host.appendChild(el);
    this.touchUI = el;
    // 双眼鏡をのぞいたときの丸い縁
    this.binoc = document.createElement('div');
    this.binoc.className = 'walk-binoc';
    this.binoc.hidden = true;
    host.appendChild(this.binoc);
    const stick = el.querySelector('.walk-stick'), knob = el.querySelector('.walk-knob');
    let sid = null;
    const setStick = (e) => {
      const r = stick.getBoundingClientRect();
      const R = r.width / 2;
      let dx = (e.clientX - (r.left + R)) / R, dy = (e.clientY - (r.top + R)) / R;
      const l = Math.hypot(dx, dy);
      if (l > 1) (dx /= l), (dy /= l);
      this.stick.x = dx;
      this.stick.y = -dy;
      knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      sid = e.pointerId;
      try {
        stick.setPointerCapture(e.pointerId);
      } catch {}
      setStick(e);
      e.preventDefault();
    });
    stick.addEventListener('pointermove', (e) => e.pointerId === sid && setStick(e));
    const release = (e) => {
      if (e.pointerId !== sid) return;
      sid = null;
      this.stick.x = this.stick.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', release);
    stick.addEventListener('pointercancel', release);
    // 押している間だけ効くボタン（ジャンプ・上昇・下降）
    for (const b of el.querySelectorAll('[data-hold]')) {
      const code = () => b.dataset.k;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchKeys.add(code());
      });
      const up = () => this.touchKeys.delete(code());
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    }
    el.querySelector('[data-run]').addEventListener('click', (e) => {
      this.run = !this.run;
      e.currentTarget.classList.toggle('on', this.run);
    });
    el.querySelector('[data-mode]').addEventListener('click', () => this.toggleMode());
    el.querySelector('[data-zoom]').addEventListener('click', () => this.setZoom(!this.zoom));
    // 触る端末で歩き始めたら出す
    const coarse = () => this.touchUsed || matchMedia('(pointer: coarse)').matches;
    this.syncTouchUI = () => {
      el.hidden = !(this.active && coarse());
      const fly = this.mode === 'fly';
      el.querySelector('[data-k="Space"]').textContent = fly ? t('上昇') : t('ジャンプ');
      el.querySelector('[data-fly]').hidden = !fly;
      el.querySelector('[data-mode]').textContent = fly ? t('歩行モード') : t('飛行モード');
      el.querySelector('[data-zoom]').textContent = t('望遠');
    };
  }
}
