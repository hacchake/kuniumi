import * as THREE from 'three';

// 雪の上の足跡：歩幅ごとに左右交互に、少し暗い小判形のへこみを地面に置く（新しい 400 個まで）。
// 位置は最初の足跡を原点にした相対で持つ（遠い所でも揺れないように）。原点から 2 km 離れたら消して置き直す。
const MAX = 400;

export class Footprints {
  // patchMaterial: 丸み・雲の影の差し込み（木と同じ）
  constructor(parent, patchMaterial) {
    // 小判形（楕円）を平らに寝かせた板
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, 0.055, 0.13, 0, Math.PI * 2);
    const geo = new THREE.ShapeGeometry(shape, 12).rotateX(-Math.PI / 2);
    this.material = new THREE.MeshStandardMaterial({
      color: 0x6f7a8a,
      roughness: 1,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    patchMaterial?.(this.material);
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'Footprints';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh);
    this.origin = null;
    this.next = 0;
    this.left = false;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
  }

  // 1 歩：x, z = 足元（平らな地図の座標）、yaw = 向き、groundAt = 地面の高さ
  step(x, z, yaw, groundAt) {
    if (!this.origin || Math.hypot(x - this.origin.x, z - this.origin.z) > 2000) {
      this.origin = { x, z };
      this.mesh.count = 0;
      this.next = 0;
    }
    this.left = !this.left;
    // 進む向きに対して左右へ 12 cm ずらす
    const side = this.left ? -0.12 : 0.12;
    const fx = x + Math.cos(yaw) * side, fz = z - Math.sin(yaw) * side;
    const y = groundAt(fx, fz) + 0.06; // 地形の三角形の分だけ少し浮かせる（埋もれて欠けないように）
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.m.compose(new THREE.Vector3(fx - this.origin.x, y, fz - this.origin.z), this.q, new THREE.Vector3(1, 1, 1));
    this.mesh.setMatrixAt(this.next, this.m);
    this.next = (this.next + 1) % MAX;
    this.mesh.count = Math.min(MAX, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.position.set(this.origin.x, 0, this.origin.z);
  }

  // 雪の残り具合（0..1）で濃さを変える。雪が解けたら消える
  setSnow(k) {
    this.material.opacity = 0.45 * k;
    this.mesh.visible = k > 0.02 && this.mesh.count > 0;
  }
}
