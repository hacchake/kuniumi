// 歩いている間の音（音の素材は使わず、その場で作る）：
//   風  ：白い雑音を帯域で絞ったもの。高い所・速く動くほど強く、ゆっくり強弱がつく
//   波  ：海の近くでは、低い雑音を寄せては返す強弱で
//   鳥  ：昼の地上で、ときどきさえずり（音の高さを素早く上下させた短い音）
// 「歩く」を押した操作の中で始めるので、ブラウザの自動再生の制限にかからない。
export class WalkAudio {
  constructor() {
    this.ctx = null;
    this.on = true;
    try {
      this.on = localStorage.getItem('kuniumi.walk.sound') !== 'off';
    } catch {}
  }

  #build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    this.ctx = ctx;
    // 2 秒の白い雑音を繰り返し使う
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.8 : 0;
    this.master.connect(ctx.destination);
    // 風
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 500;
    wf.Q.value = 0.6;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    noise().connect(wf).connect(this.wind).connect(this.master);
    this.windF = wf;
    // 波
    const sf = ctx.createBiquadFilter();
    sf.type = 'lowpass';
    sf.frequency.value = 700;
    this.sea = ctx.createGain();
    this.sea.gain.value = 0;
    noise().connect(sf).connect(this.sea).connect(this.master);
    this.t = 0;
    this.nextBird = 2;
    return true;
  }

  start() {
    if (!this.ctx && !this.#build()) return;
    this.ctx.resume?.();
  }

  stop() {
    this.ctx?.suspend?.();
  }

  setOn(on) {
    this.on = on;
    try {
      localStorage.setItem('kuniumi.walk.sound', on ? 'on' : 'off');
    } catch {}
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.1);
  }

  // 毎コマ：above = 地面からの高さ (m)、speed = 動く速さ (m/s)、nearSea = 0..1、day = 0..1（昼）
  update(dt, { above, speed, nearSea, day, inForest }) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.t += dt;
    const gust = 0.6 + 0.4 * Math.sin(this.t * 0.37) * Math.sin(this.t * 0.11 + 1.3);
    const w = Math.min(0.5, 0.05 + Math.min(1, above / 300) * 0.12 + Math.min(1, speed / 40) * 0.3) * gust;
    this.wind.gain.setTargetAtTime(w, now, 0.3);
    this.windF.frequency.setTargetAtTime(380 + speed * 8 + gust * 200, now, 0.3);
    // 波：寄せては返す（約 7 秒）
    const wave = 0.5 + 0.5 * Math.sin((this.t / 7) * Math.PI * 2);
    this.sea.gain.setTargetAtTime(nearSea * (0.06 + 0.18 * wave * wave), now, 0.4);
    // 鳥：昼の地上（森なら多く）
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 1.5 + Math.random() * (inForest ? 3 : 9);
      if (day > 0.5 && above < 40) this.#chirp();
    }
  }

  #chirp() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1800;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
    for (let k = 0; k < n; k++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const s = t0 + k * (0.09 + Math.random() * 0.05);
      o.frequency.setValueAtTime(base, s);
      o.frequency.exponentialRampToValueAtTime(base * (1.3 + Math.random() * 0.4), s + 0.04);
      o.frequency.exponentialRampToValueAtTime(base * 0.8, s + 0.08);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.025, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.09);
      o.connect(g);
      g.connect(pan ?? this.master);
      o.start(s);
      o.stop(s + 0.1);
    }
    if (pan) pan.connect(this.master);
  }
}
