import * as THREE from 'three';

// 舟の航跡：進む舟の後ろの水面に白い泡の粒を残す。泡はゆっくり横へ広がり、数秒で薄れて消える。
// 位置は平らな地図の座標で持ち、カメラからの相対で描く（雨や水しぶきと同じ）。
const N = 900;
const LIFE = 7; // 秒

export class Wake {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.uniforms = { gain: { value: 1 } };
    this.points = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // 明るさを足す（照り返しで白い水面の上でも、泡が灰色に沈まない）
        vertexShader: `
          attribute float alpha;
          varying float vA;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vA = alpha;
            vec4 mv = modelViewMatrix * vec4( position, 1.0 );
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp( 0.5 * projectionMatrix[1][1] * 400.0 / max( 0.5, -mv.z ), 1.0, 40.0 );
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          uniform float gain;
          varying float vA;
          #include <logdepthbuf_pars_fragment>
          void main() {
            #include <logdepthbuf_fragment>
            float r = length( gl_PointCoord - 0.5 ) * 2.0;
            float a = ( 1.0 - smoothstep( 0.4, 1.0, r ) ) * vA;
            if ( a < 0.01 ) discard;
            gl_FragColor = vec4( vec3( 0.92, 0.95, 0.97 ) * gain, a * 0.18 );
          }`,
      }),
    );
    this.points.name = 'Wake';
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
    this.foam = [];
  }

  // 泡を足す：x, z = 平らな地図の座標、y = 水面、vx, vz = 横へ広がる速さ
  add(x, y, z, vx, vz) {
    if (this.foam.length >= N) this.foam.shift();
    this.foam.push({ x, y, z, vx, vz, age: 0 });
  }

  // at: カメラの描く位置、ref: カメラの平らな地図の座標、exposure: 露出、light: 昼夜の明るさ
  update(at, ref, exposure, light = 1) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    this.foam = this.foam.filter((f) => (f.age += dt) < LIFE);
    this.points.visible = this.foam.length > 0;
    if (!this.points.visible) return;
    const pos = this.points.geometry.attributes.position.array;
    const al = this.points.geometry.attributes.alpha.array;
    this.foam.forEach((f, i) => {
      const slow = Math.exp(-f.age * 0.6); // 広がる速さは次第に落ちる
      f.x += f.vx * slow * dt;
      f.z += f.vz * slow * dt;
      pos[i * 3] = f.x - ref.x;
      pos[i * 3 + 1] = f.y - ref.y;
      pos[i * 3 + 2] = f.z - ref.z;
      al[i] = Math.min(1, f.age * 4) * (1 - f.age / LIFE);
    });
    this.points.geometry.setDrawRange(0, this.foam.length);
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.alpha.needsUpdate = true;
    this.points.position.copy(at);
    this.uniforms.gain.value = (0.7 / Math.max(0.02, exposure)) * light;
  }
}
