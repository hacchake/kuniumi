import * as THREE from 'three';
import { createTerrainGeometry, applyHeights, createTerrainMaterial } from './terrainMesh.js';
import { sunDirection, sunLight } from '../core/sun.js';

// 「どの描画器でも解釈できる」標準的な素材だけで組んだシーン。
// glTF 書き出しに使い、将来の高画質一枚絵モード（パストレーサ等）もここを入力にする想定。
// リアルタイム専用の Sky / Water シェーダはここには入れない。

export const NAMES = { terrain: 'Terrain', water: 'Water', sun: 'Sun', camera: 'Camera' };

// Blender の glTF 読み込みは 683 lm/W で W/m² に換算するので、それを見越した照度にする
const LUX_PER_UNIT = 683;

export function buildPortableScene(scene, { field, res, colorTexture }) {
  const root = new THREE.Scene();
  root.name = scene.meta.name || 'KUNIUMI';
  const t = scene.terrain;

  // 地形
  const geo = createTerrainGeometry(res);
  applyHeights(geo, field, res, t);
  const terrain = new THREE.Mesh(geo, createTerrainMaterial(colorTexture));
  terrain.name = NAMES.terrain;
  root.add(terrain);

  // 水面：有限の板。透過・屈折率を持つ PBR 素材にしておくと Blender でそのままガラス状の水になる
  if (scene.water.enabled) {
    const span = t.size * 3;
    const wgeo = new THREE.PlaneGeometry(span, span, 1, 1);
    wgeo.rotateX(-Math.PI / 2);
    const color = new THREE.Color(scene.water.color);
    const mat = new THREE.MeshPhysicalMaterial({
      name: 'Water',
      color: new THREE.Color(1, 1, 1),
      roughness: 0.03,
      metalness: 0,
      transmission: 1,
      ior: 1.333,
      thickness: 30,
      attenuationColor: color.clone().lerp(new THREE.Color(1, 1, 1), 0.35),
      attenuationDistance: 25,
    });
    const water = new THREE.Mesh(wgeo, mat);
    water.name = NAMES.water;
    water.position.y = scene.water.level;
    root.add(water);
  }

  // 太陽：glTF の平行光源はノードの -Z 方向へ光る。向きはノードの回転だけで表す
  // （three の target は書き出さない。子にすると Blender に余計な空オブジェクトが出るため）
  const dir = new THREE.Vector3(...sunDirection(scene.sun.elevation, scene.sun.azimuth));
  const { color, strength } = sunLight(scene.sun.elevation, scene.sun.intensity);
  const sun = new THREE.DirectionalLight(new THREE.Color(...color), Math.max(strength, 0.0001) * LUX_PER_UNIT);
  sun.name = NAMES.sun;
  sun.position.copy(dir).multiplyScalar(t.size);
  sun.lookAt(0, 0, 0);
  root.add(sun);

  // カメラ
  const still = scene.render.still;
  const cam = new THREE.PerspectiveCamera(scene.camera.fov, still.width / still.height, 1, t.size * 20);
  cam.name = NAMES.camera;
  cam.position.fromArray(scene.camera.position);
  cam.lookAt(new THREE.Vector3().fromArray(scene.camera.target));
  root.add(cam);

  return root;
}
