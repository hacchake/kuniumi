import * as THREE from 'three';

// 星の丸み（地平線の曲がり）。地図は平らなまま持ち、描くときに「注視点」を中心に球面へ曲げる。
// 中心から水平に d 離れた点は、角度 θ = d / R だけ回り込んだ所にあると見なす（正距方位図法の逆）。
// 中心の近くはほとんど変わらず、遠くほど下がって地平線の向こうへ沈む。
// カメラの位置も同じ式で曲げるので、高く昇ると丸い星を回り込むように眺められる。
// 1 − cos θ は 2 sin²(θ/2) で計算する（R が 6371 km でも、近くの高さの精度を落とさないため）。

export const CURVE_GLSL = /* glsl */ `
  uniform float kPlanetR; // 星の半径 (m)。0 なら平ら
  uniform vec2 kCenter;   // 曲げの中心（注視点の x, z。描くときの座標で）
  uniform vec3 kCamPos;   // 平らな地図の上でのカメラの位置（描くときの座標で。地形の細かさの判定用）
  vec3 kCurve( vec3 p ) {
    if ( kPlanetR <= 0.0 ) return p;
    vec2 r = p.xz - kCenter;
    float d = length( r );
    if ( d < 1e-3 ) return p;
    float th = d / kPlanetR;
    float s = sin( th * 0.5 );
    float rh = kPlanetR + p.y;
    vec2 h = kCenter + r / d * ( rh * sin( th ) );
    return vec3( h.x, p.y * cos( th ) - 2.0 * kPlanetR * s * s, h.y );
  }
  // 面の向きも同じだけ傾ける（遠くの地面ほど太陽に対する向きが変わり、夜の側ができる）
  vec3 kCurveN( vec3 p, vec3 n ) {
    if ( kPlanetR <= 0.0 ) return n;
    vec2 r = p.xz - kCenter;
    float d = length( r );
    if ( d < 1e-3 ) return n;
    float th = d / kPlanetR;
    vec3 u = vec3( r.x / d, 0.0, r.y / d );
    float a = dot( n, u ), b = n.y;
    vec3 rest = n - u * a - vec3( 0.0, b, 0.0 );
    float c = cos( th ), s = sin( th );
    return rest + ( u * c - vec3( 0.0, s, 0.0 ) ) * a + ( u * s + vec3( 0.0, c, 0.0 ) ) * b;
  }
`;

// JS 版（カメラの位置・視錐台の判定など）は core/curvature.js
export { curvePoint } from '../core/curvature.js';

export const createCurveUniforms = () => ({
  kPlanetR: { value: 0 },
  kCenter: { value: new THREE.Vector2() },
  kCamPos: { value: new THREE.Vector3() },
});
