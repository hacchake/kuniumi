// glb と一緒に使う Blender 用セットアップスクリプト（.py）を作る。
// glTF には「空」を入れられないので、太陽の向きに合わせた物理空をワールドに組み、
// カメラ・レンダー設定までを整えて、開いてすぐレンダリングできる状態にする。

export function blenderScript(scene, glbName) {
  const a = scene.atmosphere;
  const still = scene.render.still;
  const cfg = {
    glb: glbName,
    air: +(a.rayleigh / 2.2).toFixed(3),
    dust: +(a.turbidity / 6).toFixed(3),
    width: still.width,
    height: still.height,
    samples: still.samples,
    clip: Math.round(scene.terrain.size * 20),
  };
  return `# KUNIUMI → Blender セットアップ（${scene.meta.name}）
# 使い方: このファイルを ${glbName} と同じフォルダに置き、Blender の Scripting タブで開いて「実行」。
#         またはコマンドライン:  blender --python ${glbName.replace(/\.glb$/, '')}_blender.py
# glb の地形・水・太陽・カメラを読み込み、太陽の向きに合わせた物理空をワールドに設定します。
import bpy, math, os
from mathutils import Vector

GLB_NAME = ${JSON.stringify(cfg.glb)}
SKY_STRENGTH = 0.3      # 空の明るさ。露出が強すぎる/弱すぎるときはここを調整
USE_SKY_SUN = True      # True: 空の太陽円盤で照らす（読み込んだ Sun ライトはレンダーで非表示）
AIR_DENSITY = ${cfg.air}   # KUNIUMI の「空の青さ」からの近似
DUST_DENSITY = ${cfg.dust}  # KUNIUMI の「大気の濁り」からの近似
RES_X, RES_Y, SAMPLES = ${cfg.width}, ${cfg.height}, ${cfg.samples}


def find_glb():
    dirs = []
    try:
        dirs.append(os.path.dirname(os.path.abspath(__file__)))
    except NameError:
        pass
    try:
        t = bpy.context.space_data.text
        if t and t.filepath:
            dirs.append(os.path.dirname(bpy.path.abspath(t.filepath)))
    except AttributeError:
        pass
    if bpy.data.filepath:
        dirs.append(os.path.dirname(bpy.data.filepath))
    for d in dirs:
        p = os.path.join(d, GLB_NAME)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(GLB_NAME + " が見つかりません。スクリプトと同じフォルダに置いてください")


def set_if(obj, name, value):
    if hasattr(obj, name):
        try:
            setattr(obj, name, value)
        except (TypeError, ValueError):
            pass


scene = bpy.context.scene
before = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=find_glb())
new_objs = [o for o in bpy.data.objects if o not in before]

sun = next((o for o in new_objs if o.type == 'LIGHT' and o.data.type == 'SUN'), None)
cam = next((o for o in new_objs if o.type == 'CAMERA'), None)

# --- 空（物理空）---
world = scene.world or bpy.data.worlds.new("KUNIUMI Sky")
scene.world = world
world.use_nodes = True
nt = world.node_tree
nt.nodes.clear()
sky = nt.nodes.new("ShaderNodeTexSky")
bg = nt.nodes.new("ShaderNodeBackground")
out = nt.nodes.new("ShaderNodeOutputWorld")
sky.location, bg.location, out.location = (-400, 0), (-150, 0), (100, 0)
nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
bg.inputs["Strength"].default_value = SKY_STRENGTH

types = [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items]
for t in ("MULTIPLE_SCATTERING", "NISHITA", "SINGLE_SCATTERING"):
    if t in types:
        sky.sky_type = t
        break

if sun:
    # Sun ライトの光は -Z へ進む。その逆が太陽のある向き
    s = -(sun.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0)))
    set_if(sky, "sun_elevation", math.asin(max(-1.0, min(1.0, s.z))))
    # Cycles の空: 回転0で太陽は +Y、正の回転で西(-X)回り
    set_if(sky, "sun_rotation", math.atan2(-s.x, s.y) % (2 * math.pi))
    sun.data.angle = math.radians(0.53)
    if USE_SKY_SUN:
        sun.hide_render = True
set_if(sky, "sun_disc", USE_SKY_SUN)
set_if(sky, "air_density", AIR_DENSITY)
set_if(sky, "dust_density", DUST_DENSITY)
set_if(sky, "aerosol_density", DUST_DENSITY)

# --- カメラとレンダー ---
if cam:
    scene.camera = cam
    cam.data.clip_end = ${cfg.clip}
scene.render.engine = 'CYCLES'
scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.cycles.samples = SAMPLES

# 広い景観なのでビューポートの描画距離も伸ばす
for win in bpy.context.window_manager.windows:
    for area in win.screen.areas:
        if area.type == 'VIEW_3D':
            for sp in area.spaces:
                if sp.type == 'VIEW_3D':
                    sp.clip_end = ${cfg.clip}

print("KUNIUMI: セットアップ完了 —", GLB_NAME)
`;
}
