import * as THREE from 'three';
import { moonDirection, moonIllumination } from '../core/sun.js';
import { loadMoonMap } from '../three/moonTexture.js';

// 月：空の箱（半径 100 km）の少し内側に、満ち欠けした円盤として描く。太陽の側が光り、
// 欠けた側もほんのり見える（地球照）。表面は月面図（core/moonMap.js：実際の表側の海・クレーター・光条）。山や雲より奥。
const DIST = 90000;
const SIZE_DEG = 1.5; // 見かけの直径（実際は約 0.52°。画面の上で形が分かるよう大きめに。写真で望遠にしたときの印象）

export class Moon {
  constructor(scene) {
    const r = DIST * Math.tan(THREE.MathUtils.degToRad(SIZE_DEG / 2));
    this.uniforms = {
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      gain: { value: 1 },
      moonTex: { value: null },
      hasTex: { value: 0 },
    };
    // 月面図はワーカーで作る（できるまではノイズの模様）
    loadMoonMap()
      .then((m) => {
        const tex = new THREE.DataTexture(m.albedo, m.W, m.H, THREE.RedFormat, THREE.FloatType);
        tex.wrapS = THREE.RepeatWrapping;
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        tex.needsUpdate = true;
        this.uniforms.moonTex.value = tex;
        this.uniforms.hasTex.value = 1;
      })
      .catch(() => {});
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(r * 2, r * 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending, // 昼は青空に重ねて淡く、夜はそのまま
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vRight, vUp, vFwd;
          #include <common>
          #include <logdepthbuf_pars_vertex>
          void main() {
            vUv = uv * 2.0 - 1.0;
            // 板の向き（世界座標）：右・上・こちら向き
            vRight = normalize( ( modelMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
            vUp = normalize( ( modelMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
            vFwd = normalize( ( modelMatrix * vec4( 0.0, 0.0, 1.0, 0.0 ) ).xyz );
            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            #include <logdepthbuf_vertex>
          }`,
        fragmentShader: `
          uniform vec3 sunDir;
          uniform float gain, hasTex;
          uniform sampler2D moonTex;
          varying vec2 vUv;
          varying vec3 vRight, vUp, vFwd;
          #include <logdepthbuf_pars_fragment>
          float h( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
          float vn( vec2 p ) {
            vec2 i = floor( p ), f = fract( p );
            f = f * f * ( 3.0 - 2.0 * f );
            return mix( mix( h( i ), h( i + vec2( 1, 0 ) ), f.x ), mix( h( i + vec2( 0, 1 ) ), h( i + 1.0 ), f.x ), f.y );
          }
          void main() {
            #include <logdepthbuf_fragment>
            float r2 = dot( vUv, vUv );
            if ( r2 > 1.0 ) discard;
            vec3 n = normalize( vUv.x * vRight + vUv.y * vUp + sqrt( 1.0 - r2 ) * vFwd );
            float lit = smoothstep( -0.04, 0.12, dot( n, sunDir ) );
            // 海（暗い所）と細かいむら
            float m = vn( vUv * 2.2 + 3.0 ) * 0.6 + vn( vUv * 6.0 ) * 0.3 + vn( vUv * 18.0 ) * 0.1;
            float albedo = mix( 0.55, 1.0, smoothstep( 0.35, 0.6, m ) );
            if ( hasTex > 0.5 ) {
              // 表側をこちらに向けた月の緯度・経度（右が東、上が北）。月面図は行 0 = 北緯 90°
              float z = sqrt( 1.0 - r2 );
              float lat = asin( clamp( vUv.y, -1.0, 1.0 ) ), lon = atan( vUv.x, z );
              albedo = texture2D( moonTex, vec2( lon / 6.2831853 + 0.5, 0.5 - lat / 3.1415927 ) ).r * 0.9;
            }
            float edge = 1.0 - smoothstep( 0.92, 1.0, r2 ); // 縁をなめらかに
            vec3 c = vec3( 1.0, 0.97, 0.9 ) * albedo * ( lit + 0.01 );
            gl_FragColor = vec4( c * gain, edge );
          }`,
      }),
    );
    this.mesh.name = 'Moon';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  // at: カメラの描く位置、sunDir: 太陽の向き、age: 月齢（日）、exposure: 露出、day: 昼の明るさ（0..1。昼は空に溶けて淡い）
  update(at, sunDir, age, exposure, day = 0) {
    const s = sunDir.clone().normalize();
    const d = new THREE.Vector3(...moonDirection(s.toArray(), age));
    this.dir = d;
    this.mesh.visible = d.y > -0.02 && moonIllumination(age) > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.copy(at).addScaledVector(d, DIST);
    this.mesh.lookAt(at);
    this.uniforms.sunDir.value.copy(s);
    // 夜は明るく、昼は空に負けて淡く。地平線の近くでは大気で少し暗く
    this.uniforms.gain.value = (0.9 / Math.max(0.02, exposure)) * (1 - 0.75 * day) * (0.5 + 0.5 * THREE.MathUtils.smoothstep(d.y, 0, 0.15));
  }
}
