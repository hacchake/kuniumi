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
