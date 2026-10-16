// 地球モードの大気（一回散乱：レイリー + ミー）と地表の色。
// 座標は「地球中心からの相対」（camC = カメラの ECEF）。描くときの原点はカメラ。

export const GLOBE_ATMO_GLSL = /* glsl */ `
  uniform vec3 camC;      // カメラの位置（地球中心から, m）
  uniform vec3 sunDir;    // 太陽の向き（ECEF）
  uniform float planetR, atmoR, sunI;
  const vec3 BETA_R = vec3( 5.8e-6, 13.5e-6, 33.1e-6 );
  const float BETA_M = 4e-6; // 晴れた日のちり・水滴（ミー散乱）
  const float HR = 8000.0, HM = 1200.0;

  // 中心が原点の球と光線の交わり（t0, t1）。交わらなければ t0 > t1
  vec2 gRaySphere( vec3 ro, vec3 rd, float r ) {
    float b = dot( ro, rd );
    float c = dot( ro, ro ) - r * r;
    float d = b * b - c;
    if ( d < 0.0 ) return vec2( 1e30, -1e30 );
    d = sqrt( d );
    return vec2( - b - d, - b + d );
  }

  // p から太陽へ向かう光が通る空気の量（レイリー, ミー）。地球の陰なら大きな値
  vec2 gSunDepth( vec3 p ) {
    // 地球の陰は、その点の高さより少し下の球で判定する（粗い区画は三角形の真ん中が球より数 km 沈むため）
    vec2 tp = gRaySphere( p, sunDir, min( planetR, length( p ) ) - 300.0 );
    vec2 ta = gRaySphere( p, sunDir, atmoR );
    float len = max( 0.0, ta.y );
    float dt = len / 4.0;
    vec2 od = vec2( 0.0 );
    for ( int i = 0; i < 4; i ++ ) {
      float h = length( p + sunDir * ( ( float( i ) + 0.5 ) * dt ) ) - planetR;
      od += exp( - max( h, 0.0 ) / vec2( HR, HM ) ) * dt;
    }
    // 地球の陰：太陽への光線が地球に当たる（境目はやわらかく）
    if ( tp.x < tp.y && tp.y > 0.0 ) od += vec2( 1e7 );
    return od;
  }

  vec3 gTrans( vec2 od ) { return exp( - ( BETA_R * od.x + BETA_M * 1.1 * od.y ) ); }

  // 光線 ro + rd t（0..tMax）で、空気が散らして目に届く光と、背景が透けて見える割合
  void gAtmosphere( vec3 ro, vec3 rd, float tMax, int steps, out vec3 inscatter, out vec3 trans ) {
    inscatter = vec3( 0.0 );
    trans = vec3( 1.0 );
    vec2 ta = gRaySphere( ro, rd, atmoR );
    float t0 = max( 0.0, ta.x ), t1 = min( ta.y, tMax );
    if ( t1 <= t0 ) return;
    float dt = ( t1 - t0 ) / float( steps );
    vec2 od = vec2( 0.0 );
    vec3 sumR = vec3( 0.0 ), sumM = vec3( 0.0 );
    for ( int i = 0; i < 16; i ++ ) {
      if ( i >= steps ) break;
      vec3 p = ro + rd * ( t0 + ( float( i ) + 0.5 ) * dt );
      float h = max( 0.0, length( p ) - planetR );
      vec2 d = exp( - h / vec2( HR, HM ) ) * dt;
      od += d;
      vec3 att = gTrans( od + gSunDepth( p ) );
      sumR += att * d.x;
      sumM += att * d.y;
    }
    float mu = dot( rd, sunDir );
    float pR = 0.0596831 * ( 1.0 + mu * mu );
    const float g = 0.76;
    float pM = 0.1193662 * ( 1.0 - g * g ) * ( 1.0 + mu * mu ) / ( ( 2.0 + g * g ) * pow( 1.0 + g * g - 2.0 * g * mu, 1.5 ) );
    inscatter = sunI * ( sumR * BETA_R * pR + sumM * BETA_M * pM );
    trans = gTrans( od );
  }
`;

// 地表の色：標高・傾き・緯度から（衛星写真は使わない）
export const GLOBE_SURFACE_GLSL = /* glsl */ `
  float gHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }

  // 雪線（m）：低緯度は高い山だけ、極に近いほど低く。南極は海面から氷
  float gSnowLine( float lat ) {
    float a = abs( lat );
    float s = 5000.0 * pow( clamp( ( 78.0 - a ) / 48.0, 0.0, 1.0 ), 0.8 );
    return lat < - 60.0 ? 0.0 : s;
  }

  vec3 gLandColor( float h, float slope, float lat ) {
    float a = abs( lat );
    // 緯度ごとの低地の色：熱帯の濃い緑 → 温帯の緑 → 北方の暗い緑 → ツンドラの茶
    vec3 tropic = vec3( 0.030, 0.070, 0.022 ), temper = vec3( 0.050, 0.085, 0.030 );
    vec3 boreal = vec3( 0.040, 0.060, 0.035 ), tundra = vec3( 0.16, 0.15, 0.11 );
    vec3 low = mix( tropic, temper, smoothstep( 15.0, 35.0, a ) );
    low = mix( low, boreal, smoothstep( 48.0, 58.0, a ) );
    low = mix( low, tundra, smoothstep( 63.0, 70.0, a ) );
    // 高くなるほど草地・岩へ
    vec3 high = vec3( 0.12, 0.10, 0.075 ), rock = vec3( 0.15, 0.14, 0.125 );
    vec3 c = mix( low, high, smoothstep( 900.0, 2600.0, h ) );
    c = mix( c, rock, smoothstep( 0.45, 0.9, slope ) );
    // 浜辺
    c = mix( vec3( 0.40, 0.37, 0.28 ), c, smoothstep( 0.5, 3.0, h ) );
    // 雪（急な斜面には積もりにくい）
    float sl = gSnowLine( lat );
    float snow = smoothstep( sl - 150.0, sl + 250.0, h ) * ( 1.0 - smoothstep( 0.6, 1.1, slope ) );
    return mix( c, vec3( 0.80, 0.84, 0.88 ), snow );
  }

  vec3 gWaterColor( float depth ) {
    return mix( vec3( 0.025, 0.10, 0.11 ), vec3( 0.006, 0.025, 0.07 ), smoothstep( 2.0, 60.0, depth ) );
  }

  // その場所の東・北・上
  void gFrame( vec3 wp, out vec3 e, out vec3 n, out vec3 u ) {
    u = normalize( wp );
    e = vec3( u.z, 0.0, - u.x );
    float l = length( e );
    e = l > 1e-5 ? e / l : vec3( 1.0, 0.0, 0.0 );
    n = cross( u, e );
  }

  // 地表の点 wp（地球中心から）の照らされた色。h = 標高、g = 東・北への傾き（誇張込み）
  // img: 衛星写真の色（線形）と、使う割合
  vec3 gShade( vec3 wp, vec3 viewDir, float h, vec2 g, float iceCap, vec4 img ) {
    vec3 e, n, u;
    gFrame( wp, e, n, u );
    float lat = degrees( asin( clamp( u.y, -1.0, 1.0 ) ) );
    vec3 N = normalize( u - g.x * e - g.y * n );
    float slope = length( g );
    vec3 sunT = gTrans( gSunDepth( wp + u * 5.0 ) );
    float cosU = dot( u, sunDir );
    // 空からの光（昼側ほど明るい。夜はわずか）
    vec3 sky = vec3( 0.35, 0.5, 0.8 ) * 0.07 * sunI * smoothstep( -0.15, 0.35, cosU ) + vec3( 0.004, 0.006, 0.012 ) * sunI;
    vec3 albedo;
    float ndl;
    // 海か陸か：標高が 0 m 未満でも、衛星写真が水に見えなければ陸（海抜すれすれの水田・干拓地・街）。
    // 写真がまだ無い所は標高で、深い所（−60 m 未満）はいつも海（水らしさは io/photo.js の photoWater と同じ判定）
    float wLum = dot( img.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    float wLike = max( smoothstep( 0.88, 1.0, img.b / max( img.g, 1e-4 ) ) * smoothstep( 0.11, 0.07, wLum ),
                       smoothstep( 0.85, 0.95, img.b / max( img.g, 1e-4 ) ) * smoothstep( 0.6, 0.45, img.r / max( img.g, 1e-4 ) ) ); // 南の海の浅瀬も
    // 写真がある所では、海岸線は写真の形に合わせる（粗い標高データの四角い段に合わせない）
    bool water = iceCap < 0.5 && ( img.a < 0.5 ? h < 0.0 : ( h < -60.0 || ( wLike > 0.5 && h < 5.0 ) ) );
    if ( water ) {
      // 写真があれば水の色も写真から（写真の陸の色とのつなぎ目に段ができないように）
      albedo = img.a > 0.5 ? mix( gWaterColor( - h ), img.rgb * 0.7, 0.75 ) : gWaterColor( - h );
      N = u;
    } else if ( iceCap > 0.5 ) {
      albedo = vec3( 0.82, 0.86, 0.9 );
    } else {
      albedo = gLandColor( h, slope, lat );
      // 写真は真上から見た色なので、急な斜面の岩肌は少し残す
      albedo = mix( albedo, img.rgb * 0.8 * mix( 1.0, 0.85, smoothstep( 0.5, 1.2, slope ) ), img.a );
    }
    ndl = max( dot( N, sunDir ), 0.0 );
    vec3 col = albedo * ( sunI * sunT * ndl + sky );
    if ( water ) {
      // 太陽の照り返しと、空の映り込み
      vec3 hv = normalize( sunDir - viewDir );
      float sp = pow( max( dot( N, hv ), 0.0 ), 900.0 ) * 3.0 + pow( max( dot( N, hv ), 0.0 ), 60.0 ) * 0.06;
      float fr = 0.02 + 0.98 * pow( 1.0 - max( dot( N, - viewDir ), 0.0 ), 5.0 );
      col += sunI * sunT * sp * step( 0.0, dot( u, sunDir ) ) + sky * fr * 2.0;
    }
    return col;
  }
`;

// 雲の層（地表から cloudH の高さの薄い殻。手続きの雲：方向の 3D ノイズで、大きな雲の群れから数 km の雲まで）。
// 地表・空の画素ごとに「視線が雲の層を通る所」の雲を求めて重ね、地表には太陽からの雲の影も落とす。
// GLOBE_ATMO_GLSL の後に置く
export const GLOBE_CLOUD_GLSL = /* glsl */ `
  uniform float cloudOn, cloudH, cloudCover, cloudTime;
  float cHash( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return fract( ( p.x + p.y ) * p.z );
  }
  float cNoise( vec3 p ) {
    vec3 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( cHash( i ), cHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( cHash( i + vec3( 0, 1, 0 ) ), cHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( cHash( i + vec3( 0, 0, 1 ) ), cHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( cHash( i + vec3( 0, 1, 1 ) ), cHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
  // 雲の濃さ（0..1）。u: 地球中心からの向き。oct: 重ねる段の数（遠くや影では少なく）
  float gCloudDensity( vec3 u, int oct ) {
    // 大きな流れ（低気圧の渦のようなゆがみ）
    // 2 段のゆがみで、風に引き伸ばされた筋や渦にする
    vec3 q = u * 2.2 + vec3( cloudTime * 0.01, 0.0, 0.0 );
    vec3 w = vec3( cNoise( q ), cNoise( q + 17.1 ), cNoise( q + 31.7 ) ) - 0.5;
    vec3 q2 = u * 5.0 + w * 2.2;
    vec3 w2 = vec3( cNoise( q2 + 5.3 ), cNoise( q2 + 11.9 ), cNoise( q2 + 23.3 ) ) - 0.5;
    // 東西に引き伸ばす（偏西風・貿易風の向き）
    vec3 east = normalize( vec3( u.z, 0.0, - u.x ) + 1e-5 );
    vec3 p = u * 6.0 + w * 2.6 + w2 * 0.9 + east * dot( w, east ) * 1.5 + vec3( 0.0, cloudTime * 0.02, 0.0 );
    float n = 0.0, a = 0.5, sum = 0.0;
    for ( int i = 0; i < 10; i ++ ) {
      if ( i >= oct ) break;
      n += cNoise( p ) * a;
      sum += a;
      p = p * 2.13 + 1.7;
      a *= 0.52;
    }
    n /= sum;
    // 熱帯の上と中緯度の帯に多く、亜熱帯の高気圧の帯（緯度 25° 付近）は少なく
    float lat = abs( u.y );
    float band = 0.06 * cos( lat * 12.0 ) - 0.04;
    float c0 = 1.0 - cloudCover - band;
    // 縁はやわらかく（薄い雲の広がり）、芯は濃く
    return smoothstep( c0 - 0.08, c0 + 0.22, n ) * smoothstep( c0 - 0.08, c0 + 0.05, n );
  }
  // 視線 ro + rd t（t < tMax）で見える雲：rgb = 光った雲の色、a = 不透明さ、tc = 雲までの距離
  vec4 gClouds( vec3 ro, vec3 rd, float tMax, out float tc ) {
    tc = 0.0;
    if ( cloudOn < 0.5 ) return vec4( 0.0 );
    float rc = planetR + cloudH;
    vec2 t = gRaySphere( ro, rd, rc );
    if ( t.x > t.y ) return vec4( 0.0 );
    tc = length( ro ) < rc ? t.y : t.x;
    if ( tc <= 0.0 || tc > tMax ) return vec4( 0.0 );
    vec3 p = ro + rd * tc;
    vec3 u = normalize( p );
    // 遠いほど粗く（細かい段はちらつくだけなので省く）
    int oct = int( clamp( 10.0 - log2( max( 1.0, tc / 4000.0 ) ), 4.0, 10.0 ) );
    float d = gCloudDensity( u, oct );
    if ( d <= 0.001 ) return vec4( 0.0 );
    float mu = dot( u, sunDir );
    vec3 sunT = gTrans( gSunDepth( p ) );
    // 雲は白く、昼の側は太陽で、夜の側は暗く。厚い所ほど下側が少し暗い
    vec3 col = sunI * ( sunT * smoothstep( -0.12, 0.2, mu ) * ( 0.75 - 0.25 * d ) + vec3( 0.06, 0.08, 0.12 ) * smoothstep( -0.3, 0.3, mu ) ) * 0.9;
    return vec4( col, d * 0.92 );
  }
  // 地表の点 wp に落ちる雲の影（1 = 日なた）
  float gCloudShadow( vec3 wp ) {
    if ( cloudOn < 0.5 ) return 1.0;
    vec2 t = gRaySphere( wp, sunDir, planetR + cloudH );
    if ( t.y <= 0.0 ) return 1.0;
    vec3 p = wp + sunDir * t.y;
    return 1.0 - 0.75 * gCloudDensity( normalize( p ), 5 );
  }
`;
