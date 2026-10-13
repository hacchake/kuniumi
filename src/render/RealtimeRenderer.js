import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { touches } from '../core/schema.js';
import { sunDirection, sunLight, hazeColor } from '../core/sun.js';
import { TerrainService } from '../three/TerrainService.js';
import { createTerrainGeometry, applyHeights, createColorTexture, createTerrainMaterial } from '../three/terrainMesh.js';
import { createWaterNormals } from '../three/waterNormals.js';

// リアルタイム表示モード。ストアのシーンを購読し、変わった部分だけ作り直す。
// 将来の「歩き回るモード」はここに操作系を足す。高画質書き出しは別の描画器が同じシーンを読む。
export class RealtimeRenderer {
  constructor(canvas, store, { onStatus } = {}) {
    this.store = store;
    this.onStatus = onStatus ?? (() => {});

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    this.scene.add(this.water);

    // 地形（高さ場はワーカーから届く）
    this.terrain = null;
    this.colorTexture = null;
    this.terrainData = null; // { field, res }
    this.terrainService = new TerrainService(
      (r) => this.#onTerrain(r),
      (err) => this.onStatus(`地形の生成に失敗: ${err}`, 'error'),
    );

    this.clock = new THREE.Clock();
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(canvas.parentElement);

    store.subscribe((s, changed, meta) => this.#apply(s, changed, meta));
    this.#apply(store.get(), ['*'], {});
    renderer.setAnimationLoop(() => this.#frame());
  }

  // 書き出しなどで「いまの地形」を確実に使うための待ち合わせ
  async ready() {
    await this.terrainService.idle();
    return { field: this.terrainData.field, res: this.terrainData.res, colorTexture: this.colorTexture };
  }

  #apply(s, changed, meta) {
    const has = (p) => touches(changed, p);

    if (has('terrain') || has('water.level') || has('water.enabled')) {
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
      const dir = new THREE.Vector3(...sunDirection(s.sun.elevation, s.sun.azimuth));
      u.sunPosition.value.copy(dir);
      this.water.material.uniforms.sunDirection.value.copy(dir).normalize();

      const { color, strength } = sunLight(s.sun.elevation, s.sun.intensity);
      this.sun.color.setRGB(...color);
      this.sun.intensity = strength;
      this.water.material.uniforms.sunColor.value.setRGB(...color).multiplyScalar(Math.min(1, strength / 2));
      this.#placeSun(s);

      this.renderer.toneMappingExposure = a.exposure;
      this.scene.environmentIntensity = a.ambient;
      const hz = hazeColor(s.sun.elevation, a.rayleigh);
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
      this.terrain = new THREE.Mesh(createTerrainGeometry(res), createTerrainMaterial(this.colorTexture));
      this.terrain.castShadow = true;
      this.terrain.receiveShadow = true;
      this.scene.add(this.terrain);
    }
    this.terrain.material.map = this.colorTexture;
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
    this.envTarget?.dispose();
    this.envScene.add(this.sky);
    this.envTarget = this.pmrem.fromScene(this.envScene);
    this.scene.add(this.sky);
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

  #frame() {
    const dt = this.clock.getDelta();
    if (this.envDirty) this.#updateEnvironment();
    this.water.material.uniforms.time.value += dt * 0.6;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

const round1 = (v) => Math.round(v * 10) / 10;
