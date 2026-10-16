import * as THREE from 'three';

// 虹：太陽を背にして、太陽と反対の点から 約 42° の輪（主虹、外が赤）と 約 51° の輪（副虹、色が逆で淡い）。
// カメラの周り（半径 RADIUS m の球の内側）に描き、それより近い山や木には隠れる。雨が降っていて、
// 太陽が地平線の上・42° より低いときだけ出る（太陽が高いと虹は地平線の下に沈む）。
const RADIUS = 900;

export class Rainbow {
  constructor(scene) {
    this.uniforms = {
      antiSun: { value: new THREE.Vector3(0, -1, 0) },
      strength: { value: 0 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader: `
          varying vec3 vDir;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vDir = normalize( position );
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          uniform vec3 antiSun;
          uniform float strength;
          varying vec3 vDir;
          #include <logdepthbuf_pars_fragment>
          // 波長（0 = 赤 … 1 = 紫）からおおよその色
          vec3 spectrum( float t ) {
            return clamp( vec3(
              1.0 - smoothstep( 0.25, 0.5, t ) + smoothstep( 0.85, 1.0, t ) * 0.5,
              smoothstep( 0.1, 0.35, t ) * ( 1.0 - smoothstep( 0.55, 0.8, t ) ),
              smoothstep( 0.5, 0.75, t )
            ), 0.0, 1.0 );
          }
          void main() {
            #include <logdepthbuf_fragment>
            vec3 d = normalize( vDir );
            float ang = degrees( acos( clamp( dot( d, antiSun ), -1.0, 1.0 ) ) );
            // 主虹：42.3°（赤）〜 40.5°（紫）
            float t1 = ( 42.4 - ang ) / 2.0;
            float b1 = smoothstep( -0.15, 0.1, t1 ) * ( 1.0 - smoothstep( 0.9, 1.15, t1 ) );
            // 副虹：50.2°（赤）〜 53.4°（紫）、淡く
            float t2 = ( ang - 50.0 ) / 3.3;
            float b2 = smoothstep( -0.15, 0.1, t2 ) * ( 1.0 - smoothstep( 0.9, 1.15, t2 ) ) * 0.35;
            // 主虹の内側はほんのり明るく、主虹と副虹の間（アレキサンダーの暗帯）は暗いまま
            float inner = ( 1.0 - smoothstep( 30.0, 40.5, ang ) ) * smoothstep( 15.0, 30.0, ang ) * 0.06;
            vec3 c = spectrum( clamp( t1, 0.0, 1.0 ) ) * b1 + spectrum( clamp( t2, 0.0, 1.0 ) ) * b2 + vec3( inner );
            // 地平線の下には出さない
            c *= smoothstep( -0.01, 0.03, d.y );
            gl_FragColor = vec4( c * strength, 1.0 );
          }`,
      }),
    );
    this.mesh.name = 'Rainbow';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.level = 0;
  }

  // at: カメラの位置（描く座標）、sunDir: 太陽の向き（y = 上）、rain: 雨が降っているか、exposure: 露出（明るさの尺度をそろえる）
  // clouds: 雲の量（0..1。厚い雲で日が差さないほど淡く）
  update(at, sunDir, rain, exposure, clouds = 0) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    sunDir = sunDir.clone().normalize();
    const elev = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sunDir.y, -1, 1)));
    // 太陽が低いほど虹は高く大きい。42° に近づくと地平線に沈む
    const want = rain ? THREE.MathUtils.smoothstep(elev, 1, 5) * (1 - THREE.MathUtils.smoothstep(elev, 34, 42)) : 0;
    // ゆっくり現れて消える
    this.level += (want - this.level) * Math.min(1, dt * 0.4);
    this.mesh.visible = this.level > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(at);
    this.uniforms.antiSun.value.copy(sunDir).negate();
    this.uniforms.strength.value = this.level * (1 - 0.6 * clouds) * (0.15 / Math.max(0.02, exposure));
  }
}
