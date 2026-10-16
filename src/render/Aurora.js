import * as THREE from 'three';

// オーロラ：夜の北の空（南半球の取り込み地形では南の空）に、ゆらめく光のカーテン。
// 下の縁は緑（酸素 557.7 nm）、上へ行くほど薄く赤紫（酸素 630 nm・窒素）。
// カメラの周りの大きな球（半径 RADIUS）の内側に描き、それより手前の山には隠れる。
// 見え方：空の向き（方位・高さ）からカーテンの模様を作る（カーテンは東西に長く、縦の筋が流れる）。
const RADIUS = 80000;

export class Aurora {
  constructor(scene) {
    this.uniforms = {
      time: { value: 0 },
      strength: { value: 0 },
      north: { value: 1 }, // 1 = 北の空、-1 = 南の空
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 96, 48),
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
          uniform float time, strength, north;
          varying vec3 vDir;
          #include <logdepthbuf_pars_fragment>
          float hash( float n ) { return fract( sin( n ) * 43758.5453 ); }
          float noise1( float x ) {
            float i = floor( x ), f = fract( x );
            return mix( hash( i ), hash( i + 1.0 ), f * f * ( 3.0 - 2.0 * f ) );
          }
          float noise2( vec2 p ) {
            vec2 i = floor( p ), f = fract( p );
            f = f * f * ( 3.0 - 2.0 * f );
            float n = i.x + i.y * 57.0;
            return mix( mix( hash( n ), hash( n + 1.0 ), f.x ), mix( hash( n + 57.0 ), hash( n + 58.0 ), f.x ), f.y );
          }
          void main() {
            #include <logdepthbuf_fragment>
            vec3 d = normalize( vDir );
            float el = asin( clamp( d.y, -1.0, 1.0 ) );
            if ( el < -0.02 ) discard;
            // 方位（北 = -z を 0、東 = +x）。南の空に出すときは向きを反転
            vec2 hz = normalize( vec2( d.x, - d.z * north ) + 1e-5 );
            float az = atan( hz.x, hz.y ); // -π..π、0 = 北（南）
            // カーテンの帯：北の空の高さ 10〜45° に、方位でうねりながら
            float wave = noise1( az * 2.0 + time * 0.03 ) * 0.25 + noise1( az * 5.0 - time * 0.05 ) * 0.08;
            float base = 0.16 + wave; // 帯の下の縁の高さ（ラジアン）
            float above = el - base;
            float band = smoothstep( -0.03, 0.0, above ) * exp( - max( above, 0.0 ) * 4.0 );
            // 方位で北から離れるほど弱く（地平線沿いに東西へ広がる）
            band *= smoothstep( 1.9, 0.6, abs( az ) );
            // 縦の筋：方位に沿って細かく、ゆっくり流れる
            float rays = noise2( vec2( az * 40.0 + time * 0.25, above * 2.0 ) ) * 0.6 + noise2( vec2( az * 110.0 - time * 0.4, 0.0 ) ) * 0.4;
            rays = 0.35 + 0.9 * rays * rays;
            // 明るさのむら（ときどき明るく踊る）
            float pulse = 0.6 + 0.4 * noise1( az * 3.0 + time * 0.2 );
            float a = band * rays * pulse;
            // 色：下の縁は緑、上は赤紫
            vec3 col = mix( vec3( 0.15, 1.0, 0.45 ), vec3( 0.75, 0.25, 0.6 ), smoothstep( 0.05, 0.35, above ) );
            col = mix( col, vec3( 0.6, 1.0, 0.75 ), smoothstep( 0.02, -0.02, above ) * 0.5 ); // 下の縁は白っぽく
            a *= smoothstep( -0.02, 0.05, el ); // 地平線では消える
            gl_FragColor = vec4( col * a * strength, 1.0 );
          }`,
      }),
    );
    this.mesh.name = 'Aurora';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // at: カメラの描く位置、amount: 強さ（0..1）、night: 夜の度合い（0..1）、exposure: 露出、south: 南半球か
  update(at, amount, night, exposure, south = false) {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - (this.last ?? now));
    this.last = now;
    const k = amount * night;
    this.mesh.visible = k > 0.005;
    if (!this.mesh.visible) return;
    this.uniforms.time.value += dt;
    this.uniforms.north.value = south ? -1 : 1;
    this.mesh.position.copy(at);
    this.uniforms.strength.value = k * (0.35 / Math.max(0.02, exposure));
  }
}
