// Mapbox Vector Tile（MVT、protobuf）の最小の読み取り。指定した層の地物（属性と形）だけを取り出す。
// 形はタイルの中の座標（0..extent、y は下向き）の輪（多角形は輪の並び）で返す。Three.js も DOM も使わない。

function reader(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let pos = 0;
  const varint = () => {
    let r = 0, s = 0, x;
    do {
      x = b[pos++];
      if (s < 28) r |= (x & 0x7f) << s;
      else r += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return r >>> 0 === r ? r : r;
  };
  return {
    get pos() {
      return pos;
    },
    set pos(v) {
      pos = v;
    },
    b,
    varint,
    // フィールド番号と型
    tag() {
      const t = varint();
      return [t >>> 3, t & 7];
    },
    bytes() {
      const n = varint();
      const out = b.subarray(pos, pos + n);
      pos += n;
      return out;
    },
    skip(type) {
      if (type === 0) varint();
      else if (type === 1) pos += 8;
      else if (type === 2) pos += varint();
      else if (type === 5) pos += 4;
    },
  };
}

const td = new TextDecoder();

function readValue(buf) {
  const r = reader(buf);
  let v = null;
  while (r.pos < buf.length) {
    const [f, t] = r.tag();
    if (f === 1) v = td.decode(r.bytes());
    else if (f === 2) {
      v = new DataView(buf.buffer, buf.byteOffset + r.pos, 4).getFloat32(0, true);
      r.pos += 4;
    } else if (f === 3) {
      v = new DataView(buf.buffer, buf.byteOffset + r.pos, 8).getFloat64(0, true);
      r.pos += 8;
    } else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) {
      const z = r.varint();
      v = (z >>> 1) ^ -(z & 1);
    } else if (f === 7) v = !!r.varint();
    else r.skip(t);
  }
  return v;
}

const packed = (buf) => {
  const r = reader(buf);
  const out = [];
  while (r.pos < buf.length) out.push(r.varint());
  return out;
};

// 形のコマンド列 → 輪の並び（[[x, y], …] の配列）
function decodeGeometry(cmds) {
  const rings = [];
  let x = 0, y = 0, cur = null;
  for (let i = 0; i < cmds.length; ) {
    const c = cmds[i++];
    const id = c & 7, count = c >>> 3;
    if (id === 7) {
      if (cur) rings.push(cur);
      cur = null;
      continue;
    }
    for (let k = 0; k < count; k++) {
      const dx = cmds[i++], dy = cmds[i++];
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      if (id === 1) {
        if (cur) rings.push(cur);
        cur = [[x, y]];
      } else cur.push([x, y]);
    }
  }
  if (cur) rings.push(cur);
  return rings;
}

// タイル（ArrayBuffer）から層 layerName の地物：[{ type（1 点 2 線 3 面）, props, rings }]、extent
export function readLayer(buf, layerName) {
  const r = reader(buf);
  const data = r.b;
  while (r.pos < data.length) {
    const [f, t] = r.tag();
    if (f !== 3) {
      r.skip(t);
      continue;
    }
    const lb = r.bytes();
    const lr = reader(lb);
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (lr.pos < lb.length) {
      const [lf, lt] = lr.tag();
      if (lf === 1) name = td.decode(lr.bytes());
      else if (lf === 2) feats.push(lr.bytes());
      else if (lf === 3) keys.push(td.decode(lr.bytes()));
      else if (lf === 4) values.push(readValue(lr.bytes()));
      else if (lf === 5) extent = lr.varint();
      else lr.skip(lt);
    }
    if (name !== layerName) continue;
    const features = feats.map((fb) => {
      const fr = reader(fb);
      let type = 0, tags = [], geom = [];
      while (fr.pos < fb.length) {
        const [ff, ft] = fr.tag();
        if (ff === 2) tags = packed(fr.bytes());
        else if (ff === 3) type = fr.varint();
        else if (ff === 4) geom = packed(fr.bytes());
        else fr.skip(ft);
      }
      const props = {};
      for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = values[tags[k + 1]];
      return { type, props, rings: decodeGeometry(geom) };
    });
    return { features, extent };
  }
  return { features: [], extent: 4096 };
}

// 輪の符号付き面積（タイルの座標：y は下向き）
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a / 2;
}

// 面の地物の輪を、外側の輪とその穴の組に分ける（MVT では外側と穴は向きが逆）
export function polygonsOf(rings) {
  const out = [];
  let sign = 0;
  for (const ring of rings) {
    const a = ringArea(ring);
    if (!a) continue;
    if (!sign) sign = Math.sign(a);
    if (Math.sign(a) === sign || !out.length) out.push({ outer: ring, holes: [] });
    else out[out.length - 1].holes.push(ring);
  }
  return out;
}
