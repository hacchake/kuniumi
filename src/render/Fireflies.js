import * as THREE from 'three';

// 蛍：夏（と春の終わり）の夜、地面の近く（2 km より低い所から見ているとき）でカメラの周り BOX m に舞う。
// 一匹ずつゆっくり漂い、数秒おきにふわっと光っては消える（黄緑色）。木や水の上でもよい。
// 位置は平らな地図の座標で持ち、カメラが遠ざかったら反対側へ移して、いつも周りにいるようにする。
const N = 160;
const BOX = 70; // 周りの範囲（一辺 m）

export class Fireflies {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.uniforms = { gain: { value: 1 }, size: { value: 0.15 } };
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          attribute float glow;
          uniform float size;
          varying float vGlow;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vGlow = glow;
            vec4 mv = modelViewMatrix * vec4( position, 1.0 );
            gl_Position = projectionMatrix * mv;
            // 近いほど大きく（画面の高さに対して）。1.5〜18 画素
            gl_PointSize = clamp( size * projectionMatrix[1][1] * 400.0 / max( 0.5, -mv.z ), 1.5, 18.0 );
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          uniform float gain;
          varying float vGlow;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            float r = length( gl_PointCoord - 0.5 ) * 2.0;
            float a = exp( - r * r * 6.0 ) * vGlow;
            if ( a < 0.003 ) discard;
            gl_FragColor = vec4( vec3( 0.75, 1.0, 0.35 ) * a * gain, 1.0 );
          }`,
      }),
    );
    this.points.name = 'Fireflies';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.flies = [];
    this.level = 0;
  }

  // at: カメラの描く位置、ref: カメラの平らな地図の座標、groundAt(x, z): 地面の高さ、
  // on: 出す条件（夏の夜・地面の近く）、exposure: 露出、waterLevel: 水面（水の上では水面の少し上を飛ぶ）
  update(at, ref, groundAt, on, exposure, waterLevel = -Infinity) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    this.level += ((on ? 1 : 0) - this.level) * Math.min(1, dt * 0.5);
    this.points.visible = this.level > 0.01;
    if (!this.points.visible) return;
    const floor = (x, z) => Math.max(groundAt(x, z), waterLevel);
    if (!this.flies.length) {
      for (let i = 0; i < N; i++) {
        const x = ref.x + (Math.random() - 0.5) * BOX, z = ref.z + (Math.random() - 0.5) * BOX;
        this.flies.push({ x, z, h: 0.4 + Math.random() * 2.5, ph: Math.random() * 10, per: 3 + Math.random() * 4, a: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.4 });
      }
    }
    const pos = this.points.geometry.attributes.position.array;
    const glow = this.points.geometry.attributes.glow.array;
    for (let i = 0; i < N; i++) {
      const f = this.flies[i];
      // ふらふら向きを変えながら漂う
      f.a += (Math.random() - 0.5) * 2 * dt;
      f.x += Math.cos(f.a) * f.sp * dt;
      f.z += Math.sin(f.a) * f.sp * dt;
      // 範囲の外に出たら反対側へ（カメラが遠くへ飛んでも、いつも周りに）
      const wrap = (d) => ((((d + BOX / 2) % BOX) + BOX) % BOX) - BOX / 2;
      f.x = ref.x + wrap(f.x - ref.x);
      f.z = ref.z + wrap(f.z - ref.z);
      const y = floor(f.x, f.z) + f.h + Math.sin(now * 0.7 + f.ph) * 0.3;
      pos[i * 3] = f.x - ref.x;
      pos[i * 3 + 1] = y - ref.y;
      pos[i * 3 + 2] = f.z - ref.z;
      // 数秒おきに 1 秒ほど光る
      const k = ((now + f.ph) % f.per) / f.per;
      glow[i] = Math.pow(Math.max(0, Math.sin(Math.min(1, k * 4) * Math.PI)), 2);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.glow.needsUpdate = true;
    this.points.position.copy(at);
    this.uniforms.gain.value = this.level * (1.2 / Math.max(0.02, exposure));
  }
}
