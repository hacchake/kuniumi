import * as THREE from 'three';

// 小舟：歩くモードで深い水の上に出ると乗っている（カメラは舟の後ろ寄りに座った高さ）。
// 舷（ふなべり）は外形から内側の形をくり抜いて押し出した壁、底は内側の形の板。木の色。
export class Boat {
  constructor(parent, patchMaterial) {
    const outline = (w, l, s) => {
      const sh = new THREE.Shape();
      // 上から見た形：−y（艫）は四角く、+y（舳先）はとがる。寝かせると +y が前（−z）になる
      sh.moveTo(-w, -l * 0.55);
      sh.lineTo(w, -l * 0.55);
      sh.bezierCurveTo(w * 1.05, l * 0.1, w * 0.8, l * 0.45, 0, l * 0.62 * s);
      sh.bezierCurveTo(-w * 0.8, l * 0.45, -w * 1.05, l * 0.1, -w, -l * 0.55);
      return sh;
    };
    const outer = outline(0.62, 3.2, 1);
    const inner = outline(0.54, 3.0, 0.97);
    outer.holes.push(new THREE.Path(inner.getPoints(24).reverse()));
    const wall = new THREE.ExtrudeGeometry(outer, { depth: 0.42, bevelEnabled: false, curveSegments: 16 }).rotateX(-Math.PI / 2);
    const floor = new THREE.ShapeGeometry(inner, 16).rotateX(-Math.PI / 2).translate(0, 0.06, 0);
    const mat = (color) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, side: THREE.DoubleSide });
      patchMaterial?.(m);
      return m;
    };
    this.group = new THREE.Group();
    this.group.name = 'Boat';
    const hull = new THREE.Mesh(wall, mat(0x6b4a2f));
    const deck = new THREE.Mesh(floor, mat(0x8a6a48));
    // 腰掛けの板
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.28).translate(0, 0.3, 0.5), mat(0x7a5a3a));
    for (const m of [hull, deck, seat]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.group.visible = false;
    parent.add(this.group);
  }

  // at: 舟の中心（水面の高さ、平らな地図の座標）、yaw: 向き、roll / pitch: 揺れ（ラジアン）
  place(at, yaw, roll, pitch) {
    this.group.position.copy(at);
    this.group.rotation.set(pitch, yaw, roll, 'YXZ');
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }
}
