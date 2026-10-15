import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { touches } from '../core/schema.js';
import { sunDirection, sunLight, hazeColor } from '../core/sun.js';
import { TerrainService } from '../three/TerrainService.js';
import { createTerrainGeometry, applyHeights, createColorTexture, createTerrainMaterial, DETAIL_TILE } from '../three/terrainMesh.js';
import { createWaterNormals } from '../three/waterNormals.js';
import { TextureService } from '../three/TextureService.js';
import { ObjectLayer } from '../three/objectLayer.js';

const R2D = 180 / Math.PI;

// リアルタイム表示モード。ストアのシーンを購読し、変わった部分だけ作り直す。
// 将来の「歩き回るモード」はここに操作系を足す。高画質書き出しは別の描画器が同じシーンを読む。
export class RealtimeRenderer {
  constructor(canvas, store, { onStatus, selection } = {}) {
    this.store = store;
    this.selection = selection; // 画面上の選択（シーンデータではない UI 状態）: { selected: id|null }
    this.onStatus = onStatus ?? (() => {});

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xffffff, 0);
    this.camera = new THREE.PerspectiveCamera(50, 1, 2, 300000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 20;
    this.controls.zoomToCursor = true;
    // 視点を動かし終えたらシーンへ書き戻す（自分由来の変更なので再構築はしない）
    this.controls.addEventListener('end', () => this.#commitCamera());

    // 空
    this.sky = new Sky();
    this.sky.scale.setScalar(200000);
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envTarget = null;
    this.envDirty = true;

    // 太陽光
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.scene.add(this.sun, this.sun.target);

    // 水
    this.water = new Water(new THREE.PlaneGeometry(300000, 300000), {
      textureWidth: 1024,
      textureHeight: 1024,
      waterNormals: createWaterNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xffffff,
      waterColor: 0x0f3a4a,
      distortionScale: 3.7,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    // Water シェーダは霧をトーンマップの「後」に混ぜる。霧の色は物理的な明るさ（1 を超える）なので、
    // そのままでは遠くの水面が白く飛ぶ。霧を先に混ぜてから、ほかの物体と同じようにトーンマップする
    const wfs = this.water.material.fragmentShader;
    const fogInc = '#include <fog_fragment>';
    const toneInc = '#include <tonemapping_fragment>';
    if (wfs.includes(fogInc) && wfs.includes(toneInc)) {
      this.water.material.fragmentShader = wfs.replace(fogInc, '').replace(toneInc, `${fogInc}\n${toneInc}`);
      this.water.material.needsUpdate = true;
    }
    this.scene.add(this.water);

    // 地形（高さ場はワーカーから届く）
    this.terrain = null;
    this.colorTexture = null;
    this.terrainData = null; // { field, res }
    this.terrainService = new TerrainService(
      (r) => this.#onTerrain(r),
      (err) => this.onStatus(`地形の生成に失敗: ${err}`, 'error'),
    );

    // 物体（球・立方体など）と、その模様テクスチャ
    this.textureService = new TextureService((key) => this.objects.onTexture(key));
    this.objects = new ObjectLayer(this.scene, this.textureService);
    this.#setupGizmo(canvas);

    this.timer = new THREE.Timer();
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(canvas.parentElement);

    store.subscribe((s, changed, meta) => this.#apply(s, changed, meta));
    this.#apply(store.get(), ['*'], {});
    renderer.setAnimationLoop(() => this.#frame());
  }

  // 書き出しなどで「いまの地形」を確実に使うための待ち合わせ
  async ready() {
    await this.terrainService.idle();
    await this.objects.ready();
    return {
      field: this.terrainData.field,
      res: this.terrainData.res,
      colorTexture: this.colorTexture,
      objectMeshes: this.objects.exportMeshes(),
    };
  }

  // ---- 物体の置き場所 ----

  // 画面中央の先にある地面（地形か水面）の点。無ければ視線の先 size*6 の点
  // offset を渡すと、視線を平行にずらした先で探す
  groundPoint(offset = null) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    if (offset) ray.ray.origin.add(offset);
    const targets = [this.terrain, this.water.visible ? this.water : null].filter(Boolean);
    const hit = ray.intersectObjects(targets, false)[0];
    if (hit) return hit.point;
    return ray.ray.at(this.store.get().terrain.size * 0.3, new THREE.Vector3());
  }

  // 画面の右向き（水平）の単位ベクトル
  sideVector() {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    return side.lengthSq() < 1e-6 ? new THREE.Vector3(1, 0, 0) : side.normalize();
  }

  // 空に浮かぶ天体の置き場所：視線の向きの遠く、画面の上寄り（できれば地平線より上）
  skyPoint(diameter) {
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
    const half = this.camera.fov / 2 / R2D;
    let angle = pitch + half * 0.55;
    if (angle < 4 / R2D) angle = Math.min(4 / R2D, pitch + half * 0.85);
    const dist = Math.max(diameter * 3, this.store.get().terrain.size * 4);
    const dir = flat.multiplyScalar(Math.cos(angle)).setY(Math.sin(angle));
    return this.camera.position.clone().addScaledVector(dir, dist);
  }

  setGizmoMode(mode) {
    this.gizmo.setMode(mode);
  }

  // ---- 選択とギズモ ----

  #setupGizmo(canvas) {
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    const helper = this.gizmo.getHelper();
    this.scene.add(helper);
    // 水面の映り込みにはギズモを描かない
    const waterBefore = this.water.onBeforeRender;
    this.water.onBeforeRender = (...args) => {
      const vis = helper.visible;
      helper.visible = false;
      waterBefore.apply(this.water, args);
      helper.visible = vis;
    };
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) this.#commitGizmo();
    });

    // ドラッグではなく「クリック」したときだけ選択を切り替える
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0 || this.gizmo.dragging) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 4) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.objects.meshes, false)[0];
      this.selection?.set('selected', hit ? hit.object.userData.kuniumiId : null);
    });
    this.selection?.subscribe(() => this.#attachGizmo());
  }

  #attachGizmo() {
    const mesh = this.objects.meshOf(this.selection?.get().selected);
    if (mesh) this.gizmo.attach(mesh);
    else this.gizmo.detach();
  }

  // ギズモで動かし終えたら、その物体の位置・回転・大きさをシーンへ書き戻す
  #commitGizmo() {
    const mesh = this.gizmo.object;
    if (!mesh) return;
    const id = mesh.userData.kuniumiId;
    const objs = this.store.get().objects.map((o) =>
      o.id === id
        ? {
            ...o,
            position: mesh.position.toArray().map(round1),
            rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((r) => round1(r * R2D)),
            scale: mesh.scale.toArray().map(round1),
          }
        : o,
    );
    this.store.set('objects', objs, { source: 'view' });
  }

  #apply(s, changed, meta) {
    const has = (p) => touches(changed, p);

    if (has('terrain') || has('water.level') || has('water.enabled') || has('vegetation')) {
      this.terrainService.request(s);
      if (this.terrainData && has('terrain.size')) this.#updateShadowCamera(s);
    }
    // 起伏の高さ・標高はメインスレッドで即座に形を変える（色はワーカーから後追い）
    if (this.terrain && this.terrainData && (has('terrain.heightScale') || has('terrain.baseHeight') || has('terrain.size'))) {
      const { field, res } = this.terrainData;
      if (this.terrain.geometry.userData.res === res) applyHeights(this.terrain.geometry, field, res, s.terrain);
    }

    if (has('sun') || has('atmosphere')) {
      const u = this.sky.material.uniforms;
      const a = s.atmosphere;
      u.turbidity.value = a.turbidity;
      u.rayleigh.value = a.rayleigh;
      u.mieCoefficient.value = a.mieCoefficient;
      u.mieDirectionalG.value = a.mieDirectionalG;
      // 雲（r186 の Sky に入った 2D の雲層）。時間は止めておき、静止画と同じ雲にする
      u.cloudCoverage.value = a.clouds;
      u.cloudDensity.value = a.cloudDensity;
      u.cloudScale.value = a.cloudScale;
      u.cloudElevation.value = a.cloudElevation;
      u.time.value = 0;
      const dir = new THREE.Vector3(...sunDirection(s.sun.elevation, s.sun.azimuth));
      u.sunPosition.value.copy(dir);
      this.water.material.uniforms.sunDirection.value.copy(dir).normalize();

      // 太陽光の強さ・色は空の物理モデルから（空の明るさとの釣り合いが静止画と同じになる）
      const { color, strength } = sunLight(s.sun, a);
      this.sun.color.setRGB(...color);
      this.sun.intensity = strength;
      this.water.material.uniforms.sunColor.value.setRGB(...color).multiplyScalar(Math.min(1, strength / 25));
      this.#placeSun(s);

      this.renderer.toneMappingExposure = a.exposure;
      this.scene.environmentIntensity = a.ambient;
      const hz = hazeColor(s.sun, a);
      this.scene.fog.color.setRGB(...hz);
      this.scene.fog.density = a.haze * 2.2e-4;
      this.envDirty = true;
    }

    if (has('water')) {
      const w = s.water;
      this.water.visible = w.enabled;
      this.water.position.y = w.level;
      const u = this.water.material.uniforms;
      u.waterColor.value.set(w.color);
      u.distortionScale.value = w.distortion;
      u.size.value = w.waveScale;
    }

    if (has('objects')) {
      this.objects.sync(s.objects);
      this.#attachGizmo();
    }

    if (has('camera') && meta.source !== 'view') {
      const c = s.camera;
      this.camera.position.fromArray(c.position);
      this.controls.target.fromArray(c.target);
      this.camera.fov = c.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
  }

  #onTerrain({ field, res, colors, texSize }) {
    const s = this.store.get();
    this.terrainData = { field, res };
    this.colorTexture = createColorTexture(colors, texSize, this.colorTexture);
    if (!this.terrain || this.terrain.geometry.userData.res !== res) {
      if (this.terrain) {
        this.terrain.geometry.dispose();
        this.scene.remove(this.terrain);
      }
      this.terrain = new THREE.Mesh(createTerrainGeometry(res), createTerrainMaterial(this.colorTexture, s.terrain.size));
      this.terrain.castShadow = true;
      this.terrain.receiveShadow = true;
      this.scene.add(this.terrain);
    }
    this.terrain.material.map = this.colorTexture;
    this.terrain.material.normalMap.repeat.setScalar(s.terrain.size / DETAIL_TILE);
    // 計算中に起伏や大きさが変わっていても、最新のシーンで形を合わせる
    applyHeights(this.terrain.geometry, field, res, s.terrain);
    this.#updateShadowCamera(s);
    this.onStatus(null);
  }

  #placeSun(s) {
    const dir = new THREE.Vector3(...sunDirection(s.sun.elevation, s.sun.azimuth));
    const size = s.terrain.size;
    this.sun.position.copy(dir).multiplyScalar(size * 1.5);
    this.sun.target.position.set(0, 0, 0);
  }

  #updateShadowCamera(s) {
    const size = s.terrain.size;
    const cam = this.sun.shadow.camera;
    const half = size * 0.75;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = size * 4;
    cam.updateProjectionMatrix();
    this.sun.shadow.normalBias = (size / 4096) * 1.5;
    this.#placeSun(s);
  }

  #commitCamera() {
    this.store.patch(
      {
        'camera.position': this.camera.position.toArray().map(round1),
        'camera.target': this.controls.target.toArray().map(round1),
      },
      { source: 'view' },
    );
  }

  #updateEnvironment() {
    // 空を事前フィルタした環境マップにして、地形の環境光に使う
    // 太陽円盤は平行光源で別に照らすので、環境光からは外す（二重に明るくならないように）
    this.envTarget?.dispose();
    const disc = this.sky.material.uniforms.showSunDisc;
    disc.value = 0;
    this.envScene.add(this.sky);
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.add(this.sky);
    disc.value = 1;
    this.scene.environment = this.envTarget.texture;
    this.envDirty = false;
  }

  #resize() {
    const el = this.renderer.domElement.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 一枚絵を描いている間は止めて、GPU をパストレーサに譲る
  set paused(v) {
    this._paused = v;
  }

  #frame() {
    if (this._paused) return;
    this.timer.update();
    const dt = this.timer.getDelta();
    if (this.envDirty) this.#updateEnvironment();
    this.water.material.uniforms.time.value += dt * 0.6;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
