import * as THREE from 'three';
import { shapeOf, textureKey } from '../core/objects.js';

// scene.objects を Three.js のメッシュとして並べる層。
// リアルタイム表示が持ち、glb 書き出しは exportMeshes() で同じ形・素材を受け取る。

const D2R = Math.PI / 180;
const geometries = new Map();

// 形ごとの単位寸法（だいたい 1×1×1 に収まる）の形状。物体ごとの大きさは scale で付ける
export function unitGeometry(type) {
  if (geometries.has(type)) return geometries.get(type);
  let g;
  switch (type) {
    case 'box':
      g = new THREE.BoxGeometry(1, 1, 1);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(0.5, 0.5, 1, 96, 1);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(0.5, 1, 96, 1);
      break;
    case 'pyramid': {
      // 底面が 1×1 の正四角錐。面ごとに平らな陰影にする
      const c = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
      c.rotateY(Math.PI / 4);
      g = c.toNonIndexed();
      g.computeVertexNormals();
      break;
    }
    case 'torus':
      g = new THREE.TorusGeometry(0.35, 0.15, 64, 160);
      g.rotateX(-Math.PI / 2); // 寝かせておく（土星の環のように水平）
      break;
    case 'ring':
      g = ringGeometry(0.28, 0.5, 192);
      break;
    default:
      g = new THREE.SphereGeometry(0.5, 128, 64);
  }
  g.name = type;
  geometries.set(type, g);
  return g;
}

// 水平な平たい環。UV の u = 半径方向、v = 角度（縞模様が同心円になる）
function ringGeometry(inner, outer, segs) {
  const pos = [], uv = [], nrm = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    for (let r = 0; r <= 1; r++) {
      const rad = r ? outer : inner;
      pos.push(c * rad, 0, -s * rad);
      nrm.push(0, 1, 0);
      uv.push(r, i / segs);
    }
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class ObjectLayer {
  constructor(parent, textures) {
    this.group = new THREE.Group();
    this.group.name = 'Objects';
    parent.add(this.group);
    this.textures = textures;
    this.entries = new Map(); // id → { mesh, json, texKey }
  }

  get meshes() {
    return [...this.entries.values()].map((e) => e.mesh);
  }

  meshOf(id) {
    return this.entries.get(id)?.mesh ?? null;
  }

  sync(objects) {
    const keys = objects.map((o) => textureKey(o.material, shapeOf(o.type).aspect));
    this.textures.setWanted(keys);
    const alive = new Set();
    objects.forEach((o, i) => {
      alive.add(o.id);
      let e = this.entries.get(o.id);
      const json = JSON.stringify(o);
      if (e && e.json === json && e.applied) return;
      if (!e || e.type !== o.type) {
        if (e) this.#remove(o.id);
        const mesh = new THREE.Mesh(unitGeometry(o.type), new THREE.MeshPhysicalMaterial());
        mesh.userData.kuniumiId = o.id;
        this.group.add(mesh);
        e = { mesh, type: o.type };
        this.entries.set(o.id, e);
      }
      e.json = json;
      e.texKey = keys[i];
      this.#applyTransform(e.mesh, o);
      // 位置だけの変更なら素材には触らない
      const matJson = JSON.stringify([o.material, o.celestial, o.name]);
      if (matJson !== e.matJson || !e.applied) {
        e.matJson = matJson;
        e.applied = this.#applyMaterial(e.mesh, o);
      }
    });
    for (const id of [...this.entries.keys()]) if (!alive.has(id)) this.#remove(id);
  }

  // テクスチャが届いたら、それを待っていた物体に貼る
  onTexture(key) {
    for (const e of this.entries.values()) {
      if (e.texKey === key) {
        const o = JSON.parse(e.json);
        e.applied = this.#applyMaterial(e.mesh, o);
      }
    }
  }

  // 書き出し前：すべての物体にテクスチャが貼られるまで待つ
  async ready() {
    for (let i = 0; i < 50; i++) {
      await this.textures.idle();
      if ([...this.entries.values()].every((e) => e.applied)) return;
      await new Promise((r) => setTimeout(r, 30));
    }
  }

  // 書き出し用：形と素材を共有した複製（名前は重ならないように番号を付ける）
  exportMeshes() {
    const used = new Map();
    return [...this.entries.values()].map((e) => {
      const src = e.mesh;
      const m = new THREE.Mesh(src.geometry, src.material);
      m.position.copy(src.position);
      m.quaternion.copy(src.quaternion);
      m.scale.copy(src.scale);
      let name = src.name || 'Object';
      const n = used.get(name) ?? 0;
      used.set(name, n + 1);
      if (n) name = `${name}_${n + 1}`;
      m.name = name;
      m.userData = { kuniumiId: src.userData.kuniumiId };
      return m;
    });
  }

  #applyTransform(mesh, o) {
    mesh.name = o.name;
    mesh.position.fromArray(o.position);
    mesh.rotation.set(o.rotation[0] * D2R, o.rotation[1] * D2R, o.rotation[2] * D2R);
    mesh.scale.fromArray(o.scale);
    mesh.castShadow = o.castShadow && !o.celestial;
    mesh.receiveShadow = !o.celestial;
  }

  // 戻り値: テクスチャまで反映できたか
  #applyMaterial(mesh, o) {
    const m = o.material;
    const mat = mesh.material;
    const tex = this.textures.get(m, shapeOf(o.type).aspect);
    mat.name = `${o.name} 素材`;
    mat.roughness = m.roughness;
    mat.metalness = m.metalness;
    mat.transmission = m.transmission;
    mat.thickness = 0.5;
    mat.ior = 1.5;
    mat.side = o.type === 'ring' ? THREE.DoubleSide : THREE.FrontSide;
    mat.fog = !o.celestial;
    mat.emissive.set(m.glow > 0 ? 0xffffff : 0x000000);
    mat.emissiveIntensity = m.glow;
    if (tex) {
      mat.color.set(0xffffff);
      mat.map = tex.map;
      mat.normalMap = m.bump > 0 ? tex.normalMap : null;
      mat.emissiveMap = m.glow > 0 ? tex.emissiveMap : null;
    } else if (!mat.map) {
      // 模様の計算中は代表色で仮表示
      mat.color.set(m.color);
    }
    // シェーダの組み直しが要る変更のときだけ needsUpdate
    const sig = [!!mat.map, !!mat.normalMap, !!mat.emissiveMap, mat.side, mat.fog, m.transmission > 0].join();
    if (sig !== mesh.userData.matSig) {
      mesh.userData.matSig = sig;
      mat.needsUpdate = true;
    }
    return !!tex;
  }

  #remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.group.remove(e.mesh);
    e.mesh.material.dispose();
    this.entries.delete(id);
  }
}
