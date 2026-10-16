// 歩いている間の音（音の素材は使わず、その場で作る）：
//   風  ：白い雑音を帯域で絞ったもの。高い所・速く動くほど強く、ゆっくり強弱がつく
//   波  ：海の近くでは、低い雑音を寄せては返す強弱で
//   鳥  ：昼の地上で、ときどきさえずり（音の高さを素早く上下させた短い音）
//   足音：歩幅ごとに短い雑音。地面（とん）・雪（さくっ）・浅い水の中（ぱしゃ）で音を変える。着地は強く
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
    this.noiseBuf = buf;
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
    // 雨：高い音の雑音（ざーっ）
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 1800;
    this.rainG = ctx.createGain();
    this.rainG.gain.value = 0;
    noise().connect(rf).connect(this.rainG).connect(this.master);
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
  update(dt, { above, speed, nearSea, day, inForest, rain = false }) {
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
    this.rainG.gain.setTargetAtTime(rain ? 0.09 * (0.85 + 0.15 * gust) : 0, now, 0.6);
    // 鳥：昼の地上（森なら多く）。雨の日は鳴かない
    this.nextBird -= dt;
    if (this.nextBird <= 0) {
      this.nextBird = 1.5 + Math.random() * (inForest ? 3 : 9);
      if (day > 0.5 && above < 40 && !rain) this.#chirp();
    }
  }

  // 足音を 1 つ鳴らす。surface: 'ground' | 'snow' | 'water'、strength: 1 = ふつうの 1 歩（着地は大きく）
  step(surface = 'ground', strength = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    const j = 0.85 + Math.random() * 0.3; // 1 歩ごとに少し違う音
    let len, peak;
    if (surface === 'water') {
      f.type = 'bandpass';
      f.frequency.setValueAtTime(1400 * j, t0);
      f.frequency.exponentialRampToValueAtTime(500 * j, t0 + 0.25);
      f.Q.value = 0.9;
      len = 0.3;
      peak = 0.16;
    } else if (surface === 'snow') {
      f.type = 'bandpass';
      f.frequency.value = 2300 * j;
      f.Q.value = 1.4;
      len = 0.17;
      peak = 0.1;
    } else {
      f.type = 'lowpass';
      f.frequency.value = 520 * j;
      len = 0.09;
      peak = 0.22;
    }
    peak *= Math.min(2.5, strength);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + (surface === 'snow' ? 0.03 : 0.008));
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + len);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0, Math.random() * 1.5, len + 0.05);
  }

  // 雷鳴：delay 秒後に、はじめに裂ける音、あとから低い音が長く転がる。strength 0..1（近いほど大きい）
  thunder(delay = 2, strength = 0.7) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime + delay;
    const len = 3 + Math.random() * 3;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900 * strength + 200, t0);
    lp.frequency.exponentialRampToValueAtTime(90, t0 + len * 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.5 * strength, t0 + 0.05 + (1 - strength) * 0.4);
    // ごろごろ：何度か小さく盛り返しながら消える
    let t = t0 + 0.4;
    while (t < t0 + len * 0.7) {
      g.gain.linearRampToValueAtTime(0.18 * strength * (0.5 + Math.random()), t);
      t += 0.25 + Math.random() * 0.5;
    }
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + len);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + len + 0.1);
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
