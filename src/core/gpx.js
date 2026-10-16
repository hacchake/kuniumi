import { aeqdInverse } from './geo.js';

// 歩いた道すじを GPX（地図アプリ・登山アプリで開ける経路の形式）にする。
// track: [{ x, z, y, jump }]（平らな地図の座標。x = 東、z = 南、y = 標高 m）。jump のある点で区間を分ける。
// geo: 取り込んだ地形の中心 { lat, lon }（正距方位図法の中心）
export function trackToGpx(track, geo, name = 'KUNIUMI') {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const segs = [];
  for (const p of track) {
    if (p.jump || !segs.length) segs.push([]);
    const { lat, lon } = aeqdInverse(p.x, -p.z, geo.lat, geo.lon);
    segs[segs.length - 1].push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${p.y.toFixed(1)}</ele></trkpt>`);
  }
  const body = segs.filter((s) => s.length > 1).map((s) => `    <trkseg>\n${s.join('\n')}\n    </trkseg>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="KUNIUMI" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
${body}
  </trk>
</gpx>
`;
}

// GPX の文字列から経路の点を取り出す（trkpt と rtept。順番どおり）。[{ lat, lon, ele }]（ele が無ければ null）
export function parseGpx(text) {
  const pts = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(text))) {
    const attr = m[2];
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/.exec(attr)?.[1]);
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/.exec(attr)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = parseFloat(/<ele>\s*([^<]+)<\/ele>/.exec(m[4] ?? '')?.[1]);
    pts.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  return pts;
}

// GPX の地点（wpt）：[{ lat, lon, name, ele }]（名前の無いものは除く）
export function parseGpxWaypoints(text) {
  const out = [];
  const re = /<wpt\b([^>]*?)(\/>|>([\s\S]*?)<\/wpt>)/g;
  const un = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    const name = un(/<name>([\s\S]*?)<\/name>/.exec(m[3] ?? '')?.[1] ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) continue;
    const ele = parseFloat(/<ele>\s*([^<]+)<\/ele>/.exec(m[3] ?? '')?.[1]);
    out.push({ lat, lon, name, ele: Number.isFinite(ele) ? ele : null });
  }
  return out;
}

// 経路の長さ (m)（大円距離の和）
export function routeLength(pts) {
  let d = 0;
  const R = 6371008.8, D = Math.PI / 180;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const s = Math.sin(((b.lat - a.lat) * D) / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(((b.lon - a.lon) * D) / 2) ** 2;
    d += 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  return d;
}
