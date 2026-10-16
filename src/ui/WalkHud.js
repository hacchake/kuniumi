import { t } from '../i18n/index.js';

// 歩く・飛ぶときの計器：方位（帯の目盛り）・標高・地面からの高さ・速さ・歩いた道のり。画面の上の真ん中に小さく
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class WalkHud {
  constructor(host) {
    this.el = document.createElement('div');
    this.el.className = 'walk-hud';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="hud-compass"><div class="hud-tape"></div><div class="hud-mark"></div></div>
      <div class="hud-nums"><span data-hd></span><span data-alt></span><span data-agl></span><span data-spd></span><span data-dst></span></div>`;
    host.appendChild(this.el);
    this.tape = this.el.querySelector('.hud-tape');
    // 方位の帯：0〜720° を並べておき、ずらして見せる（一周しても途切れない）
    let html = '';
    for (let d = 0; d < 720; d += 15) {
      const k = d % 360;
      const label = k % 45 === 0 ? DIRS[k / 45] : '';
      html += `<span class="${label ? 'big' : ''}" style="left:${d * 2}px">${label || '·'}</span>`;
    }
    this.tape.innerHTML = html;
    this.f = {
      hd: this.el.querySelector('[data-hd]'),
      alt: this.el.querySelector('[data-alt]'),
      agl: this.el.querySelector('[data-agl]'),
      spd: this.el.querySelector('[data-spd]'),
      dst: this.el.querySelector('[data-dst]'),
    };
  }

  // info: { heading 度（北 = 0、東 = 90）, alt 標高 m, above 地面からの高さ m, speed m/s, fly } / null で隠す
  show(info) {
    this.el.hidden = !info;
    if (!info) return;
    const hd = ((info.heading % 360) + 360) % 360;
    // 帯の 1° = 2px。見えている幅の真ん中に hd が来るように
    const w = this.el.querySelector('.hud-compass').clientWidth || 220;
    this.tape.style.transform = `translateX(${w / 2 - (hd + 360) * 2}px)`;
    const m = (v) => (Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)} km` : `${Math.round(v)} m`);
    this.f.hd.textContent = `${Math.round(hd)}° ${DIRS[Math.round(hd / 45) % 8]}`;
    this.f.alt.textContent = `${t('標高')} ${m(info.alt)}`;
    this.f.agl.textContent = info.fly ? `${t('対地')} ${m(info.above)}` : '';
    this.f.spd.textContent = `${Math.round(info.speed * 3.6)} km/h`;
    // 歩いた道のり（地図の赤い線）
    this.f.dst.textContent = info.dist > 0 ? `${t('道のり')} ${info.dist >= 1000 ? `${(info.dist / 1000).toFixed(2)} km` : `${Math.round(info.dist)} m`}` : '';
  }
}
