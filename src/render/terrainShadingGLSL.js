import * as THREE from 'three';
import { hexToRgb } from '../core/terrainColor.js';
import { defaultVegetation, shoreBandOf } from '../core/vegetation.js';

// 地面の色（core/terrainColor.js の createTerrainShader と core/vegetation.js の森の規則）の GLSL 版。
// 乱数（hash2）は 32 ビット整数の計算をそのまま移しているので、森の位置などは CPU 版（一枚絵）と一致する。

export const TERRAIN_SHADING_GLSL = /* glsl */ `
  uniform vec3 tShore, tLow, tHigh, tRock, tSnow, tSoil, tForest;
  uniform float tSea, tTop, tShoreBand, tRockSlope, tSnowLine, tHeightScale;
  uniform float tWater; // 1 = 水あり
  uniform float tTrees, tVegSeed, tTreeSlope, tTreeAltMin, tTreeAltMax;
  uniform ivec2 tOriginI; // 計算の原点 / 65536 m（精度対策）

  float tSmooth( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }

  // core/noise.js の hash2 と同じ（32 ビットの掛け算と桁送り）
  float tHash2( int x, int y, int seed ) {
    uint h = uint( x ) * 374761393u + uint( y ) * 668265263u + uint( seed ) * 2147483647u;
    h = ( h ^ ( h >> 13u ) ) * 1274126177u;
    return float( h ^ ( h >> 16u ) ) / 4294967296.0;
  }
  // 格子の番号：原点（65536 m ごと）からの相対座標 local と、2 の累乗の波長 lambda から、世界の格子番号を正確に出す
  ivec2 tCell( vec2 local, float lambda, out vec2 f ) {
    vec2 q = local / lambda; vec2 fi = floor( q ); f = q - fi;
    return ivec2( fi ) + tOriginI * int( 65536.0 / lambda + 0.5 );
  }
  // core/terrainColor.js の valueNoise と同じ（座標 / 波長）
  float tValueNoise( vec2 local, float lambda, int seed ) {
    vec2 f; ivec2 i = tCell( local, lambda, f ); f = f * f * ( 3.0 - 2.0 * f );
    float a = tHash2( i.x, i.y, seed ), b = tHash2( i.x + 1, i.y, seed );
    float c = tHash2( i.x, i.y + 1, seed ), d = tHash2( i.x + 1, i.y + 1, seed );
    return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
  }
  // core/terrainDetail.js の gradNoise と同じ
  float tGrad( int x, int y, int seed, vec2 d ) { float a = tHash2( x, y, seed ) * 6.2831853; return cos( a ) * d.x + sin( a ) * d.y; }
  float tGradNoise( vec2 local, float lambda, int seed ) {
    vec2 f; ivec2 i = tCell( local, lambda, f );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float a = tGrad( i.x, i.y, seed, f ), b = tGrad( i.x + 1, i.y, seed, f - vec2( 1.0, 0.0 ) );
    float c = tGrad( i.x, i.y + 1, seed, f - vec2( 0.0, 1.0 ) ), d = tGrad( i.x + 1, i.y + 1, seed, f - vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
  }
  // core/terrainDetail.js の detailHeight と同じ（lambda0: 一番長い波長、spacing より細かい起伏は足さない）
  float tDetail( vec2 local, float lambda0, float spacing, float amount ) {
    if ( amount <= 0.0 ) return 0.0;
    float lambda = lambda0, s = 0.0;
    for ( int o = 0; o < 12; o ++ ) {
      float w = tSmooth( spacing * 2.0, spacing * 4.0, lambda );
      if ( w <= 0.0 || lambda < 0.25 ) break;
      s += tGradNoise( local, lambda, 9173 + o ) * lambda * 0.03 * w;
      lambda *= 0.5;
    }
    return s * amount;
  }
  // 勾配ノイズの値と傾き（格子 1 つぶんを単位に）。vec3( 値, d/dx, d/dz )
  vec3 tGradNoiseD( vec2 local, float lambda, int seed ) {
    vec2 f; ivec2 i = tCell( local, lambda, f );
    float aa = tHash2( i.x, i.y, seed ) * 6.2831853, ab = tHash2( i.x + 1, i.y, seed ) * 6.2831853;
    float ac = tHash2( i.x, i.y + 1, seed ) * 6.2831853, ad = tHash2( i.x + 1, i.y + 1, seed ) * 6.2831853;
    vec2 ga = vec2( cos( aa ), sin( aa ) ), gb = vec2( cos( ab ), sin( ab ) ), gc = vec2( cos( ac ), sin( ac ) ), gd = vec2( cos( ad ), sin( ad ) );
    float a = dot( ga, f ), b = dot( gb, f - vec2( 1.0, 0.0 ) ), c = dot( gc, f - vec2( 0.0, 1.0 ) ), d = dot( gd, f - vec2( 1.0, 1.0 ) );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
    float k = a - b - c + d;
    float v = a + ( b - a ) * u.x + ( c - a ) * u.y + k * u.x * u.y;
    vec2 g = ga + ( gb - ga ) * u.x + ( gc - ga ) * u.y + ( ga - gb - gc + gd ) * u.x * u.y + du * ( vec2( b - a, c - a ) + k * u.yx );
    return vec3( v, g );
  }
  // tDetail と同じ値と、その傾き（m あたり）。法線を 1 回の計算で出すため
  vec3 tDetailD( vec2 local, float lambda0, float spacing, float amount ) {
    if ( amount <= 0.0 ) return vec3( 0.0 );
    float lambda = lambda0;
    vec3 s = vec3( 0.0 );
    for ( int o = 0; o < 12; o ++ ) {
      float w = tSmooth( spacing * 2.0, spacing * 4.0, lambda );
      if ( w <= 0.0 || lambda < 0.25 ) break;
      vec3 n = tGradNoiseD( local, lambda, 9173 + o );
      s += vec3( n.x * lambda, n.yz ) * 0.03 * w; // 高さは λ 倍、傾き（格子単位 ÷ λ）も λ 倍なので 1 倍
      lambda *= 0.5;
    }
    return s * amount;
  }
  // 色のゆらぎ：大きな斑から足元の細かいムラまで（一枚絵の細かい地形と同じ式）。
  // 重いので、粗い 2 段は頂点で（tJitterCoarse）、細かい 2 段は画素で（tJitterFine）計算する。
  // spacing（頂点の間隔・画素の大きさ）より細かい段は、ちらつかないよう平均の 0 へ寄せる
  float tOct( vec2 local, float lambda, int seed, float spacing ) {
    float w = tSmooth( spacing * 2.0, spacing * 4.0, lambda );
    return w > 0.0 ? ( tValueNoise( local, lambda, seed ) - 0.5 ) * w : 0.0;
  }
  float tJitterCoarse( vec2 local, float spacing ) { return tOct( local, 64.0, 11, spacing ) * 0.6 + tOct( local, 8.0, 18, spacing ) * 0.22; }
  float tJitterFine( vec2 local, float spacing ) { return tOct( local, 2.0, 25, spacing ) * 0.12 + tOct( local, 0.5, 32, spacing ) * 0.06; }
  // 森の広がり（core/vegetation.js の clump と同じ）。頂点で計算する
  float tClump( vec2 xz, float spacing ) {
    int s = int( tVegSeed );
    float w1 = tSmooth( spacing * 2.0, spacing * 4.0, 256.0 ), w2 = tSmooth( spacing * 2.0, spacing * 4.0, 64.0 );
    float n = mix( 0.5, tValueNoise( xz, 256.0, s ), w1 ) * 0.7 + mix( 0.5, tValueNoise( xz, 64.0, s + 1 ), w2 ) * 0.3;
    return tSmooth( 0.4, 0.62, n );
  }
  // くぼみ(+)・出っ張り(−)の度合い（描く側が高さ場から入れる。core/terrainColor.js の curv と同じ）
  float tCurv = 0.0;
  // 近くの細かい色むら（2 m・0.5 m。画素より細かい段は消えているので遠景では 0）。描く側が入れる
  float tFineJit = 0.0;
  // 雪線を波打たせる斑（−0.5..0.5。描く側が入れる）
  float tSnowN = 0.0;
  // 地層の縞の細かさ（1 画素あたりの標高の変化。描く側が fwidth から入れる。0 なら縞を消さない）
  float tStrataAA = 0.0;
  // 手で植えた・伐った量（森の筆。描く側がその点のマスクから入れる）
  float tPaintAdd = 0.0;
  float tPaintCut = 0.0;
  // その点の窪地の湖の水面（湖のそばでなければとても低い値）。描く側が湖の地図から入れる
  float tLakeL = -1e9;
  // 木の密度（core/vegetation.js の forest と同じ）
  float tForestAt( float H, float slope, float wv, float clump ) {
    float alt = ( H - tSea ) / max( 1.0, tTop - tSea );
    float habitat = ( 1.0 - tSmooth( tRockSlope * 0.45 * tTreeSlope, tRockSlope * 0.85 * tTreeSlope, slope ) )
      * ( 1.0 - tSmooth( tSnowLine - 0.28, tSnowLine - 0.1, alt ) )
      * tSmooth( tShoreBand * 1.2, tShoreBand * 3.0, H - tSea )
      * ( 1.0 - tSmooth( 0.006, 0.03, wv ) );
    // 木が生える高さの範囲（植生の層。既定の 0〜1 なら制限しない）
    if ( tTreeAltMin > 0.0 || tTreeAltMax < 1.0 ) habitat *= tSmooth( tTreeAltMin - 0.03, tTreeAltMin + 0.03, alt ) * ( 1.0 - tSmooth( tTreeAltMax - 0.03, tTreeAltMax + 0.03, alt ) );
    float d = tTrees > 0.0 ? habitat * clump * min( 1.0, tTrees * 1.6 ) : 0.0;
    d += ( max( d, 0.15 + 0.8 * habitat ) - d ) * tPaintAdd;
    return d * ( 1.0 - tPaintCut );
  }
  // 地面の色（線形 RGB）
  vec3 terrainColor( float H, float slope, float wv, float jitter, float clump ) {
    float alt = ( H - tSea ) / max( 1.0, tTop - tSea );
    vec3 col = mix( tLow, tHigh, tSmooth( 0.3, 0.75, alt + jitter * 0.12 ) );
    float veg = 1.0 + jitter * 0.5;
    col *= vec3( veg * ( 1.0 + jitter * 0.25 ), veg, veg * ( 1.0 - jitter * 0.2 ) );
    col = mix( col, tSoil, tSmooth( 0.002, 0.02, wv ) * 0.7 );
    col = mix( col, tRock, tSmooth( 0.004, 0.04, - wv ) * 0.45 );
    float kFor = tForestAt( H, slope, wv, clump );
    col = mix( col, tForest, kFor * 0.85 );
    // 森の地面：一色だと平らに見えるので、近くの細かい色むら（2 m・0.5 m）だけで落ち葉と土のまだらに。
    // 粗い色むら（数十 m）まで使うと、遠くから見て黄土色の大きな斑になる
    float kFj = tFineJit * 4.0;
    col *= 1.0 + kFj * 0.5 * kFor;
    col = mix( col, vec3( 0.32, 0.22, 0.12 ) * ( 0.7 + kFj * 0.3 ), kFor * tSmooth( 0.0, 0.4, kFj ) * 0.5 );
    // 地層：周期の違う 2 つの縞を重ね、色むらで揺らす。画面で 1 本が 3 画素より細くなる所では消す
    float sPer = max( 8.0, tHeightScale * 0.03 );
    float sPh = H / sPer + jitter * 2.5;
    float sFade = 1.0 - tSmooth( 0.12, 0.35, tStrataAA / sPer );
    float strata = ( sin( sPh * 6.2831853 ) * 0.6 + sin( sPh * 14.45 + 1.7 ) * 0.4 ) * 0.09 * sFade;
    float tone = max( 0.35, 1.0 + jitter * 0.9 + strata );
    vec3 rockCol = tRock * tone * vec3( 1.0 + strata * 0.4, 1.0, 1.0 - strata * 0.3 );
    col = mix( col, rockCol, tSmooth( tRockSlope * 0.7, tRockSlope * 1.25, slope + jitter * 0.15 ) );
    // 雪：くぼみ（沢筋）では雪線より下まで降り、急な岩場でもくぼみには残る（core/terrainColor.js と同じ式）
    float sk = max( 1.0, 1500.0 / max( 1.0, tTop - tSea ) );
    float snowAlt = tSmooth( tSnowLine - 0.04 * sk, tSnowLine + 0.06 * sk, alt + ( jitter * 0.08 + tSnowN * 0.14 + clamp( tCurv, 0.0, 0.3 ) * 0.35 ) * sk );
    float lodge = max( max( 1.0 - tSmooth( tRockSlope * 1.1, tRockSlope * 1.9, slope ),
      tSmooth( 0.06, 0.2, tCurv + jitter * 0.08 ) * 0.85 * ( 1.0 - tSmooth( tRockSlope * 1.8, tRockSlope * 2.8, slope ) ) ),
      tSmooth( 0.006, 0.03, - wv ) * 0.8 );
    col = mix( col, tSnow, snowAlt * lodge );
    // 窪地の湖のそばでは、その湖の水面を基準にする（湖の岸は砂浜を細く。core/terrainColor.js と同じ）
    bool kLake = tLakeL > tSea;
    float kWl = kLake ? tLakeL : tSea;
    float kBand = kLake ? min( tShoreBand, 4.0 ) : tShoreBand;
    if ( tWater > 0.5 || kLake ) {
      float above = H - kWl;
      // 砂浜の上の縁：色むらで大きく波打たせる（等高線そのままだと定規で引いた直線になる）
      col = mix( col, tShore, ( 1.0 - tSmooth( kBand * 0.5, kBand * 1.6, above + jitter * kBand * 1.6 ) ) * ( 1.0 - tSmooth( 0.4, 0.9, slope ) ) );
      if ( above < 0.0 ) {
        float deep = tSmooth( 0.0, kBand * 6.0, - above );
        col *= vec3( 1.0 - deep * 0.55, 1.0 - deep * 0.45, 1.0 - deep * 0.35 );
      }
    }
    return min( col * ( 1.0 + jitter * 0.18 ), vec3( 1.0 ) );
  }
`;

const lin = (hex) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace);

export function createTerrainShadingUniforms() {
  const u = {};
  for (const k of ['tShore', 'tLow', 'tHigh', 'tRock', 'tSnow', 'tSoil', 'tForest']) u[k] = { value: new THREE.Color() };
  for (const k of ['tSea', 'tTop', 'tShoreBand', 'tRockSlope', 'tSnowLine', 'tHeightScale', 'tWater', 'tTrees', 'tVegSeed', 'tTreeSlope', 'tTreeAltMin', 'tTreeAltMax']) u[k] = { value: 0 };
  u.tOriginI = { value: new THREE.Vector2() }; // ivec2 として渡る（整数で入れる）
  return u;
}

// シーンの値を uniform へ（CPU 版 createTerrainShader と同じ前処理）
export function updateTerrainShadingUniforms(u, s) {
  const t = s.terrain, p = t.palette, w = s.water;
  const veg = { ...defaultVegetation(), ...(s.vegetation ?? {}) };
  u.tShore.value.copy(lin(p.shore));
  u.tLow.value.copy(lin(p.low));
  u.tHigh.value.copy(lin(p.high));
  u.tRock.value.copy(lin(p.rock));
  u.tSnow.value.copy(lin(p.snow));
  // 土砂の色：高地の色に砂浜の色を少しだけ（core/terrainColor.js と同じ）
  u.tSoil.value.copy(u.tShore.value).multiplyScalar(0.25).add(u.tHigh.value.clone().multiplyScalar(0.75));
  u.tForest.value.copy(lin(p.forest ?? '#1f3018'));
  u.tSea.value = w.enabled ? w.level : t.baseHeight - 1;
  u.tTop.value = t.baseHeight + t.heightScale;
  u.tShoreBand.value = shoreBandOf(t.heightScale, t.baseHeight, u.tSea.value, t.mode === 'heightmap' && !!t.heightmap?.geo);
  u.tRockSlope.value = p.rockSlope;
  u.tSnowLine.value = p.snowLine;
  u.tHeightScale.value = t.heightScale;
  u.tWater.value = w.enabled ? 1 : 0;
  u.tTrees.value = veg.trees;
  u.tVegSeed.value = veg.seed | 0;
  u.tTreeSlope.value = veg.treeSlope ?? 1;
  u.tTreeAltMin.value = veg.treeAltMin ?? 0;
  u.tTreeAltMax.value = veg.treeAltMax ?? 1;
}
