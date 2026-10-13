# 国産み KUNIUMI — 星をつくる景観工房

地形・空・水を手軽に組み合わせて、壮大な風景や「星そのもの」をデザインするブラウザ用 3D 景観ソフト（Three.js）。
作った風景は glTF（.glb）・16bit ハイトマップ・Blender 用スクリプトで外へ持ち出せる。

## 起動

ES モジュールと Web Worker を使うので、`index.html` の直開きではなくローカルサーバーで開く。

- `start.bat` をダブルクリック（`py -m http.server 5194` を起動してブラウザを開く）
- または `py -m http.server 5194` → http://localhost:5194/

Three.js（r170）は jsdelivr から読むので、初回はネット接続が必要。

## 操作

| 操作 | 内容 |
|---|---|
| 左ドラッグ / 右ドラッグ / ホイール | 視点の回転 / 移動 / 寄り引き |
| 右パネル | 大地・地形の性格・地表・太陽・大気・水・一枚絵 の各設定 |
| 星のひな形 | 碧の星／黄昏の群島／赤錆の荒野／氷の巨峰／異界の湿原 |
| 開く・保存 | シーン JSON（`*.kuniumi.json`） |
| glb 書出・読込 | glTF バイナリ |
| ハイトマップ書出・読込 | 16bit グレースケール PNG（JPEG・8bit PNG も読める） |
| Blender 用 .py | glb を読み込んで空・カメラ・レンダー設定まで整えるスクリプト |
| ファイルをドロップ | 拡張子で自動判別（.json / .glb / .gltf / .png / .jpg） |

作業中のシーンはブラウザの localStorage に自動で残る（消えても動作には影響しない）。

## 設計：シーン = データ、描画 = その解釈

```
            ┌──────────── シーン JSON（src/core/schema.js）────────────┐
            │ terrain / water / sun / atmosphere / camera / render     │
            └───────────────▲───────────────────────┬──────────────────┘
       UI（ui/Panel.js）が  │ store.set(path)        │ subscribe(変更パス)
       パスで書き込むだけ   │                        ▼
                 ┌──────────┴──────┐   ┌────────────────────────────┐
                 │ core/store.js   │   │ render/RealtimeRenderer.js │ ← リアルタイム表示（今）
                 └─────────────────┘   │   Sky / Water シェーダ      │    歩き回るモード（予定）
                                       └─────────────┬──────────────┘
     core/（Three.js 非依存）                        │ 共通部品
       heightfield.js 高さ場の生成                   ▼
       terrainColor.js 地表色の焼き込み    three/terrainMesh.js  高さ場 → メッシュ
       png16.js        16bit PNG 読み書き  three/portableScene.js 標準 PBR だけのシーン
       sun.js          太陽・大気の計算      ├→ io/gltf.js       .glb 書き出し
     workers/terrainWorker.js（重い計算）    └→ 高画質一枚絵モード（予定：パストレーサ等の入力）
```

- **シーン JSON が正本**。描画器・書き出しはすべてこれを読むだけで、互いを知らない。
  一枚絵モードや歩き回るモードは「同じ JSON を別の描画器で解釈する」形で足せる。
- `core/` は Three.js に依存しない（ワーカーや Node でもそのまま動く）。
- 重い処理（ノイズ生成・ハイトマップ解釈・地表色）は Web Worker。計算中に来た変更は最新の1件にまとめる。
- 起伏の高さ・標高はメインスレッドで即座に形を変え、色は後追いで届く。
- 地表の色は CPU でテクスチャに焼く。リアルタイム表示と glb 書き出しで同じ絵になる。

### シーン JSON（version 1）の主な項目

| パス | 意味 |
|---|---|
| `terrain.mode` | `noise`（手続き生成）か `heightmap`（画像） |
| `terrain.size` / `resolution` | 一辺の長さ (m) / 頂点数（129・257・513・1025） |
| `terrain.heightScale` / `baseHeight` | 標高 = baseHeight + 正規化高さ(0..1) × heightScale |
| `terrain.noise.*` | seed・frequency（山の数）・octaves・persistence・lacunarity・ridged・warp・valley・falloff |
| `terrain.heightmap` | `{ id, name, png(16bit PNG の dataURL), width, height }` |
| `terrain.palette.*` | 低地・高地・岩・雪・水辺の色、雪線、岩の出る傾斜 |
| `water.*` | enabled・level (m)・color・distortion・waveScale |
| `sun.*` | elevation（度）・azimuth（北から東回りの度）・intensity |
| `atmosphere.*` | turbidity・rayleigh・mieCoefficient・mieDirectionalG・haze・exposure・ambient |
| `camera.*` | position・target・fov |
| `render.still.*` | 一枚絵の幅・高さ・サンプル数（Blender スクリプトにも渡る） |

同じ seed・同じ設定なら必ず同じ地形になる。解像度を上げると、格子で表せる細部だけが増える（大きな形は変わらない）。

### 座標の約束

- Y が上、**北 = −Z、東 = +X**、単位はメートル（glTF と同じ）。Blender では北 = +Y、東 = +X、上 = +Z になる。
- 高さ場とハイトマップ画像は **画像の上 = 北**。

## 他ソフトとの連携

### glTF（.glb）書き出し

| ノード | 中身 |
|---|---|
| `Terrain` | 地形メッシュ（法線・UV 付き）＋ 地表色テクスチャ（PNG 埋め込み）の PBR 素材 |
| `Water` | 地形の 3 倍の板。透過（KHR_materials_transmission）・屈折率 1.333・ボリューム吸収の水素材 |
| `Sun` | 平行光源（KHR_lights_punctual）。Blender の読み込みで W/m² に換算される強さで出力 |
| `Camera` | 透視カメラ（縦横比は「一枚絵」の幅・高さ） |
| scene.extras.`kuniumi` | シーン JSON 一式（埋め込みハイトマップ画像は除く） |

### glTF 読み込み

- KUNIUMI が書いた glb なら extras から設定を復元する。
- **地形は常にメッシュの形から取り込む**（真上からの正射影で各格子点の最高点を測る）。
  Blender で地形を彫り直して glb で戻せばそれが反映され、他ソフトで作った地形メッシュもそのまま地形になる。
  取り込んだ地形は「ハイトマップ」扱いになる。ノイズ設定は残っているので、生成方法を「ノイズ」に戻せば手続き地形に戻る。
- `Water`（名前に water/水）があれば水位に、平行光源があれば太陽の向きに、カメラがあれば視点にする。

### Blender でそのままレンダリングする

1. 「glb 書出」と「Blender 用 .py」を押し、2つを同じフォルダに置く（ファイル名はそろっている）。
2. Blender の Scripting タブでその .py を開いて実行（または `blender --python 名前_blender.py`）。
   - glb を読み込み、太陽の向きに合わせた物理空（Nishita / Multiple Scattering）をワールドに設定
   - 大気の濁り・青さを近似で反映、Cycles・解像度・サンプル数・カメラを設定
3. F12 でレンダリング。明るさはスクリプト冒頭の `SKY_STRENGTH`、空の太陽円盤を使うかは `USE_SKY_SUN` で調整。

スクリプトなしでも、glb を File → Import → glTF で読めば地形・水・太陽・カメラは入る（空だけが無い）。

### ハイトマップ（16bit PNG）

- グレースケール 16bit、画素値 0..65535 → 標高 `baseHeight .. baseHeight + heightScale`、画像の上が北。
- PNG の tEXt `kuniumi` に実寸（size・heightScale・baseHeight・waterLevel）を JSON で入れている。KUNIUMI で読み込むと実寸ごと復元される。
- Blender で使う場合：Grid（一辺 = size、細分多め）に Displace モディファイア、テクスチャにこの PNG（色空間 **Non-Color**、座標 UV）、
  強さ = heightScale、中間レベル = 0、オブジェクトの Z = baseHeight。
- World Machine・Gaea・Unreal・Unity など 16bit PNG ハイトマップを受け付けるソフトとも同じ形式でやり取りできる。

## 予定（次の段階の候補）

- 歩き回るモード（地面に沿う一人称移動・速度切替）
- 高画質一枚絵モード（portableScene を入力にしたプログレッシブなパストレース、PNG/EXR 書き出し）
- 星としての表現：惑星の曲率・地平線の丸み、夜空と星々・衛星、雲、空気遠近の改善
- 地形：侵食、複数レイヤーの合成、ブラシでの手彫り、植生の散布
- 連携：EXR ハイトマップ、Blender 側での霧（ボリューム）、glb に地表のマスク類も同梱

## 確認済みのこと・注意

- ブラウザ上で、glb の往復（標高誤差 平均約 0.3 m）、16bit ハイトマップの往復（実質無損失）、
  外部ソフト風の glb（中心ずれ・extras なし）と 8bit JPEG の読み込み、JSON の往復を確認済み。
- Blender スクリプトは Python の構文と、空の太陽方位の式（Cycles の定義）を確認済み。
  ただしこの環境に Blender が無いため、Blender 上での実行は未確認。初回は結果を見て `SKY_STRENGTH` を調整する想定。
