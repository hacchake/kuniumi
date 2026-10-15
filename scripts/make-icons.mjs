// アプリのアイコン（PNG / SVG）を作る。node scripts/make-icons.mjs
// 夜空色の角丸の地に、金色の太陽と山の稜線。外部の画像ツールに頼らず、画素を直接描いて PNG にする
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function draw(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const ink = [11, 15, 26], ink2 = [26, 33, 54], gold = [217, 181, 108], gold2 = [241, 215, 154], ridge = [8, 10, 18];
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4×4 の副標本で縁を滑らかに
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const u = (x + (sx + 0.5) / 4) / size, v = (y + (sy + 0.5) / 4) / size;
        // 角丸の正方形（maskable でも切れないよう、絵は中央 80% に収める）
        const cr = 0.2, dx = Math.max(0, Math.abs(u - 0.5) - (0.5 - cr)), dy = Math.max(0, Math.abs(v - 0.5) - (0.5 - cr));
        if (Math.hypot(dx, dy) > cr) continue;
        let c = [lerp(ink2[0], ink[0], v), lerp(ink2[1], ink[1], v), lerp(ink2[2], ink[2], v)];
        // 太陽
        const d = Math.hypot(u - 0.5, v - 0.47);
        const glow = Math.exp(-((d / 0.28) ** 2)) * 0.35;
        c = c.map((ch, i) => ch + (gold2[i] - ch) * glow);
        if (d < 0.2) {
          const t = smooth(0.2, 0.0, d);
          c = gold.map((ch, i) => lerp(ch, gold2[i], t * 0.8));
        }
        // 山の稜線（手前が暗い）
        const ridgeY = 0.62 - 0.16 * Math.max(0, 1 - Math.abs(u - 0.42) / 0.22) - 0.1 * Math.max(0, 1 - Math.abs(u - 0.7) / 0.18) + 0.01 * Math.sin(u * 60);
        if (v > ridgeY) c = ridge;
        r += c[0]; g += c[1]; b += c[2]; a += 255;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = a / 255 || 1;
      px[o] = r / n; px[o + 1] = g / n; px[o + 2] = b / n; px[o + 3] = a / 16;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [192, 512]) writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), draw(s));
writeFileSync(
  new URL('../public/icon.svg', import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2136"/><stop offset="1" stop-color="#0b0f1a"/></linearGradient></defs><rect width="64" height="64" rx="13" fill="url(#g)"/><circle cx="32" cy="30" r="13" fill="#d9b56c"/><path d="M0 40 L14 33 L27 26 L37 35 L45 30 L64 41 L64 64 L0 64 Z" fill="#080a12"/></svg>\n`,
);
console.log('icons written');
