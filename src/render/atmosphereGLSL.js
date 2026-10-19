// 雲と霧のシェーダ部品（GLSL）。一枚絵（atmospherePass.js）とリアルタイム表示（RealtimeAtmosphere.js）で共有する。
//
// 雲：地図上の決まった位置にある、厚みのある層（標高 cloudBase 〜 cloudBase + cloudThick）。
//   どこに雲があるかは 2D のノイズ（Three.js の Sky の雲と同じ関数）で決め、濃い所ほど雲の頂が高くなる。
//   さらに 3D のノイズで縁を削り、もくもくした形にする。
// 霧：地表付近ほど濃い（高さで指数的に薄まる）。
//
// 大陸規模の対策：
//   cloudOrigin … 描くときの座標の原点（世界座標）。雲の模様は世界座標で決めるので足し戻す
//   cloudPlanetR, cloudCam … 星の丸み。cloudCam.xz は曲げの中心（注視点）。標高は星の中心からの距離で測る

export const CLOUD_UNIFORMS_GLSL = /* glsl */ `
  uniform float cloudScale, cloudCoverage, cloudDensity, cloudElevation, cloudBase, cloudThick;
  uniform vec2 cloudOrigin;
  uniform float cloudPlanetR;
  uniform vec3 cloudCam;
`;

export const CLOUD_FUNCS_GLSL = /* glsl */ `
  #define CLOUD_FAR 400000.0
  // 点 p の標高。丸い星では、星の中心（曲げの中心の真下 R）からの距離で測る
  vec3 kSphereC() { return vec3( cloudCam.x, - cloudPlanetR, cloudCam.z ); }
  float kAlt( vec3 p ) {
    if ( cloudPlanetR <= 0.0 ) return p.y;
    return length( p - kSphereC() ) - cloudPlanetR;
  }
  // 光線 o + t rd（o は星の中心から見た位置、altO はその標高）が、標高 A の球面と交わる t（小さい順）。無ければ x > y
  vec2 kSphereT( vec3 o, vec3 rd, float altO, float A ) {
    float b = dot( o, rd );
    float c = ( altO - A ) * ( 2.0 * cloudPlanetR + altO + A ); // |o|² − (R + A)² を桁落ちしにくい形で
    float disc = b * b - c;
    if ( disc < 0.0 ) return vec2( 1e30, -1e30 );
    float s = sqrt( disc );
    return vec2( - b - s, - b + s );
  }
  vec2 kGradient( vec2 i ) {
    vec3 p = fract( i.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yzx + 33.33 );
    return fract( ( p.xx + p.yz ) * p.zy ) * 2.0 - 1.0;
  }
  float kNoise( vec2 p ) {
    vec2 i = floor( p ); vec2 f = fract( p );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float a = dot( kGradient( i ), f );
    float b = dot( kGradient( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
    float c = dot( kGradient( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
    float d = dot( kGradient( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.6;
  }
  float kFbm( vec2 p ) {
    float r = 0.0; float a = 1.0;
    for ( int i = 0; i < 4; i ++ ) { r += a * kNoise( p ); a *= 0.5; p = p * 2.0; }
    return r;
  }
  float kHash3( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
  float kNoise3( vec3 x ) {
    vec3 i = floor( x ); vec3 f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( kHash3( i ), kHash3( i + vec3( 1, 0, 0 ) ), f.x ), mix( kHash3( i + vec3( 0, 1, 0 ) ), kHash3( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( kHash3( i + vec3( 0, 0, 1 ) ), kHash3( i + vec3( 1, 0, 1 ) ), f.x ), mix( kHash3( i + vec3( 0, 1, 1 ) ), kHash3( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
  // 雲の広がり（2D）：0 = 晴れ間、値が大きいほど濃く背の高い雲
  float cloudCover( vec2 xz ) {
    if ( cloudCoverage <= 0.0 ) return 0.0;
    vec2 uv = ( xz + cloudOrigin ) / ( 3000.0 * mix( 1.0, 0.1, cloudElevation ) ) * cloudScale;
    float n = clamp( kFbm( uv * 1000.0 ) * 0.7 + 0.5, 0.0, 1.0 );
    float region = kNoise( uv * 300.0 ) * 0.37 + 0.5;
    float cov = clamp( cloudCoverage + ( region - 0.5 ) * 0.6, 0.0, 1.0 );
    return max( 0.0, n - ( 1.0 - cov ) );
  }
  // 3D の雲の濃さ（消散係数 1/m）。detail = false なら縁の 3D ノイズを省く（影の近似用）
  float cloudSigma( vec3 p, bool detail ) {
    float hr = ( kAlt( p ) - cloudBase ) / cloudThick;
    if ( hr < 0.0 || hr > 1.0 ) return 0.0;
    float c = cloudCover( p.xz );
    if ( c <= 0.0 ) return 0.0;
    float top = clamp( c * 3.2, 0.05, 1.0 ); // 濃い所ほど頂が高い
    vec3 pw = p + vec3( cloudOrigin.x, 0.0, cloudOrigin.y );
    float big = 0.5;
    if ( detail ) {
      // 数百 m の大きなこぶ：頂の高さを場所ごとに上下させ（もくもく盛り上がる所と低い所）、底も少し揺らす。
      // これが無いと、遠くの雲が底の平らななめらかなパンケーキに見える
      big = kNoise3( pw / 700.0 );
      top = clamp( top * ( 0.65 + 0.7 * big ), 0.05, 1.0 );
      hr -= ( big - 0.5 ) * 0.08;
    }
    float prof = smoothstep( 0.0, 0.07, hr ) * ( 1.0 - smoothstep( top * 0.55, top, hr ) );
    float d = clamp( c * 2.5, 0.0, 1.0 ) * prof;
    if ( detail && d > 0.0 ) {
      // 大きなこぶ → 中くらい → 小さなこぶ → 細かいけば立ち（カリフラワー状の縁）
      float e = big * 0.3 + kNoise3( pw / 170.0 ) * 0.36 + kNoise3( pw / 56.0 ) * 0.22 + kNoise3( pw / 19.0 ) * 0.12;
      d = max( 0.0, d - e * 0.72 * ( 1.0 - d * 0.35 ) );
    }
    return d * cloudDensity * 0.09;
  }
  // 点 p から太陽方向 s へ、雲の層を抜けるまでの透過率（steps 回の標本）
  float cloudShadow( vec3 p, vec3 s, int steps ) {
    if ( cloudCoverage <= 0.0 || s.y <= 0.02 ) return 1.0;
    float top = cloudBase + cloudThick;
    float py = kAlt( p );
    if ( py >= top ) return 1.0;
    float t0 = max( 0.0, ( cloudBase - py ) / s.y );
    float t1 = ( top - py ) / s.y;
    float dt = ( t1 - t0 ) / float( steps );
    float od = 0.0;
    for ( int i = 0; i < 8; i ++ ) {
      if ( i >= steps ) break;
      od += cloudSigma( p + s * ( t0 + ( float( i ) + 0.5 ) * dt ), false ) * dt;
    }
    return exp( - od * 0.8 ); // 多重散乱で雲の下も真っ暗にはならない
  }
  float kHG( float c, float g ) { float g2 = g * g; return ( 1.0 - g2 ) / ( 12.566370614 * pow( max( 1e-4, 1.0 + g2 - 2.0 * g * c ), 1.5 ) ); }
`;

// 雲の層の中を光線で進み、雲の明るさと透過率を求める。
// ro, rd: 光線、tMax: 地表までの距離。sunE: 日光、amb: 空の光。戻り値 vec4(rgb, 透過率)
export const CLOUD_MARCH_GLSL = /* glsl */ `
  // 丸い星で、光線が雲の層（標高 cloudBase〜top）に最初に入って出るまで。
  // 標高は alt(t) = c + b t + q t²（下に凸）なので、層の上面・下面との交点は 2 次方程式で出る
  bool kLayerSpan( vec3 ro, vec3 rd, out float ta, out float tb ) {
    vec3 o = ro - kSphereC();
    float altO = length( o ) - cloudPlanetR;
    vec2 T = kSphereT( o, rd, altO, cloudBase + cloudThick ); // この間は上面より内側
    if ( T.x > T.y ) return false;
    vec2 S = kSphereT( o, rd, altO, cloudBase ); // この間は下面より内側
    ta = T.x; tb = T.y;
    if ( S.x <= S.y ) {
      // 層の中は [T.x, S.x] と [S.y, T.y]。手前のほうから
      if ( S.x > 0.0 ) { ta = T.x; tb = S.x; }
      else { ta = S.y; tb = T.y; }
    }
    ta = max( ta, 0.0 );
    return tb > ta;
  }
  vec4 marchClouds( vec3 ro, vec3 rd, float tMax, vec3 sunDir, vec3 sunE, vec3 amb, int steps, int lightSteps, float jitter ) {
    if ( cloudCoverage <= 0.0 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
    float top = cloudBase + cloudThick;
    float ta, tb;
    if ( cloudPlanetR > 0.0 ) {
      if ( ! kLayerSpan( ro, rd, ta, tb ) ) return vec4( 0.0, 0.0, 0.0, 1.0 );
    } else if ( abs( rd.y ) < 1e-4 ) {
      if ( ro.y < cloudBase || ro.y > top ) return vec4( 0.0, 0.0, 0.0, 1.0 );
      ta = 0.0; tb = 60000.0;
    } else {
      float t0 = ( cloudBase - ro.y ) / rd.y, t1 = ( top - ro.y ) / rd.y;
      ta = max( 0.0, min( t0, t1 ) ); tb = max( t0, t1 );
    }
    tb = min( tb, min( tMax, ta + 30000.0 ) );
    // 数百 km より遠い雲は画素より細かい粒になってちらつくので描かない（宇宙から星を眺めるときなど）
    if ( tb <= ta || ta > CLOUD_FAR ) return vec4( 0.0, 0.0, 0.0, 1.0 );
    float dt = ( tb - ta ) / float( steps );
    float cosT = dot( rd, sunDir );
    float phase = mix( kHG( cosT, 0.6 ), kHG( cosT, -0.25 ), 0.3 );
    vec3 L = vec3( 0.0 );
    float T = 1.0;
    for ( int i = 0; i < 128; i ++ ) {
      if ( i >= steps || T < 0.01 ) break;
      vec3 p = ro + rd * ( ta + ( float( i ) + jitter ) * dt );
      float s = cloudSigma( p, true ) * ( 1.0 - smoothstep( CLOUD_FAR * 0.3, CLOUD_FAR, ta + ( float( i ) + jitter ) * dt ) );
      if ( s <= 0.0 ) continue;
      // 太陽までの雲の厚み（粗く数点）
      float od = 0.0;
      float ls = cloudThick * 0.5 / float( lightSteps );
      for ( int j = 0; j < 8; j ++ ) {
        if ( j >= lightSteps ) break;
        od += cloudSigma( p + sunDir * ( float( j ) + 0.5 ) * ls, false ) * ls;
      }
      float hr = clamp( ( p.y - cloudBase ) / cloudThick, 0.0, 1.0 );
      // 透過＋多重散乱の近似（深い所も少し明るい）＋ 縁の明るさ（powder）
      float sunT = max( exp( - od ), exp( - od * 0.25 ) * 0.35 );
      float powder = 1.0 - exp( - s * 120.0 );
      vec3 inS = sunE * phase * sunT * mix( 0.6, 1.0, powder ) + amb * ( 0.35 + 0.65 * hr );
      float a = exp( - s * dt );
      L += T * inS * ( 1.0 - a );
      T *= a;
    }
    return vec4( L, T );
  }
`;

// 霧：地表付近ほど濃い霧の中を光線で進み、日光と空の光の散乱を足す。
// lit(p) は呼び出し側で定義する「点 p に日光が届く割合」。戻り値 vec4(rgb, 透過率)
export const FOG_MARCH_GLSL = /* glsl */ `
  uniform float fogDensity, fogHeight, fogBase, fogG;
  float fogSigma( float y ) { return fogDensity * exp( - max( 0.0, y - fogBase ) / fogHeight ); }
  // marchFog の中では、標高は丸みのぶんを足し戻して測る（kAlt）
  vec4 marchFog( vec3 ro, vec3 rd, float dist, vec3 sunDir, vec3 sunE, vec3 amb, int steps, float jitter ) {
    vec3 L = vec3( 0.0 );
    float T = 1.0;
    float phase = mix( 1.0 / 12.566370614, kHG( dot( rd, sunDir ), fogG ), 0.8 );
    // 霧があるのは地表付近だけ。上空から見下ろすときは、霧の層に入ってからの区間だけを細かく調べる
    // （何千 km の光線に少ない標本をばらまくと、薄い霧の層を取りこぼして粒になる）
    float t0 = 0.0;
    float topA = fogBase + fogHeight * 8.0;
    if ( kAlt( ro ) > topA ) {
      if ( cloudPlanetR > 0.0 ) {
        vec3 o = ro - kSphereC();
        vec2 S = kSphereT( o, rd, length( o ) - cloudPlanetR, topA );
        if ( S.x > S.y || S.y < 0.0 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
        t0 = max( 0.0, S.x );
      } else {
        if ( rd.y >= 0.0 ) return vec4( 0.0, 0.0, 0.0, 1.0 );
        t0 = ( topA - ro.y ) / rd.y;
      }
    }
    if ( t0 >= dist ) return vec4( 0.0, 0.0, 0.0, 1.0 );
    float tPrev = t0;
    for ( int i = 1; i <= 128; i ++ ) {
      if ( i > steps ) break;
      float k = ( float( i ) - 1.0 + jitter ) / float( steps );
      // 近くを細かく、遠くを粗く（上空から霧の層へ入るときは均等に）
      float t = t0 + ( dist - t0 ) * ( t0 > 0.0 ? k : k * k );
      float dt = t - tPrev;
      tPrev = t;
      vec3 p = ro + rd * t;
      float s = fogSigma( kAlt( p ) );
      if ( s < 1e-9 ) continue;
      vec3 inS = sunE * phase * lit( p ) + amb;
      float a = exp( - s * dt );
      L += T * inS * ( 1.0 - a );
      T *= a;
    }
    return vec4( L, T );
  }
`;
