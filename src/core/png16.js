// 16bit グレースケール PNG の読み書き。
// ブラウザの画像デコードは 8bit に落ちるため、ハイトマップは自前で解釈する。
// 圧縮は CompressionStream('deflate')（= zlib 形式）を使う。

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const latin1 = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 255);

// values: 0..1 の Float32Array（行0が画像の上）。text: { keyword: string } を tEXt に入れる
export async function encodeGray16(values, width, height, text = {}) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // grayscale
  const stride = width * 2 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // フィルタなし
    for (let x = 0; x < width; x++) {
      const v = Math.round(Math.min(1, Math.max(0, values[y * width + x])) * 65535);
      raw[y * stride + 1 + x * 2] = v >> 8;
      raw[y * stride + 2 + x * 2] = v & 255;
    }
  }
  const idat = await pipe(raw, new CompressionStream('deflate'));
  const parts = [Uint8Array.from(SIG), chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(text)) {
    // tEXt は Latin-1 なので、JSON は ASCII に逃がしてから入れる
    const ascii = v.replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    parts.push(chunk('tEXt', latin1(k + '\0' + ascii)));
  }
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  return new Blob(parts, { type: 'image/png' });
}

// PNG を解釈して { width, height, data: Float32Array(0..1, 1チャンネル), bitDepth, text } を返す。
// 非対応の形式（インターレース、パレット等）は null を返すので、呼び出し側で通常デコードに切り替える
export async function decodePng(buffer) {
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idats = [];
  const text = {};
  while (pos < bytes.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8);
      height = dv.getUint32(pos + 12);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'tEXt') {
      const z = data.indexOf(0);
      text[String.fromCharCode(...data.subarray(0, z))] = new TextDecoder('latin1').decode(data.subarray(z + 1));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
  if (!channels || interlace || (depth !== 8 && depth !== 16)) return null;

  const total = idats.reduce((s, d) => s + d.length, 0);
  const zdata = new Uint8Array(total);
  let off = 0;
  for (const d of idats) {
    zdata.set(d, off);
    off += d.length;
  }
  const raw = await pipe(zdata, new DecompressionStream('deflate'));

  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Float32Array(width * height);
  const maxv = depth === 16 ? 65535 : 255;
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    // 先頭チャンネル（グレー or R）を高さとして使う
    for (let x = 0; x < width; x++) {
      const o = x * bpp;
      const v = depth === 16 ? (cur[o] << 8) | cur[o + 1] : cur[o];
      out[y * width + x] = v / maxv;
    }
    prev.set(cur);
  }
  return { width, height, data: out, bitDepth: depth, text };
}
