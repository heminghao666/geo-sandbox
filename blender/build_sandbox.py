# -*- coding: utf-8 -*-
"""
geo-sandbox GLB -> Blender 场景 / 出图

用法：
  blender -b -P blender/build_sandbox.py -- \
      --glb geo-sandbox.glb --out sandbox.blend --render sandbox.png \
      --engine CYCLES --samples 64 --res 1600x900 --preset day

参数：--preset day|dusk|night   --turntable 0/1（渲染 4 帧转盘）
"""
import bpy
import bmesh
import math
import os
import sys
import argparse
from mathutils import Vector


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--out", default="sandbox.blend")
    p.add_argument("--render", default="sandbox.png")
    p.add_argument("--engine", default="CYCLES")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--res", default="1600x900")
    p.add_argument("--preset", default="day")
    p.add_argument("--turntable", type=int, default=0)
    return p.parse_args(argv)


A = parse_args()

PRESETS = {
    "day": dict(sun=(1.0, 0.96, 0.88), sun_energy=3.6, sun_angle=3.0,
                sky=(0.62, 0.74, 0.90), ground=(0.42, 0.40, 0.36),
                world=(0.55, 0.68, 0.85), world_strength=0.65, exposure=0.0),
    "dusk": dict(sun=(1.0, 0.70, 0.45), sun_energy=2.6, sun_angle=6.0,
                 sky=(0.55, 0.45, 0.55), ground=(0.30, 0.26, 0.28),
                 world=(0.38, 0.30, 0.42), world_strength=0.5, exposure=0.3),
    "night": dict(sun=(0.62, 0.74, 1.0), sun_energy=0.6, sun_angle=4.0,
                  sky=(0.10, 0.14, 0.24), ground=(0.06, 0.07, 0.10),
                  world=(0.05, 0.07, 0.13), world_strength=0.5, exposure=1.0),
}
P = PRESETS.get(A.preset, PRESETS["day"])

RES_X, RES_Y = (int(x) for x in A.res.lower().split("x"))

# ---------------------------------------------------------------- 清空
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- 导入 GLB
if not os.path.exists(A.glb):
    raise SystemExit("[build_sandbox] GLB 不存在: %s" % A.glb)

bpy.ops.import_scene.gltf(filepath=A.glb)
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit("[build_sandbox] 导入后没有任何网格对象")

# glTF 导入后 three 的 y-up 会被转成 z-up，原点保持区域中心
bpy.context.view_layer.update()

# ---------------------------------------------------------------- 包围盒
mn = Vector((1e18, 1e18, 1e18))
mx = Vector((-1e18, -1e18, -1e18))
for o in meshes:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        mn = Vector((min(mn[i], w[i]) for i in range(3)))
        mx = Vector((max(mx[i], w[i]) for i in range(3)))
size = mx - mn
center = (mn + mx) / 2
radius = max(size.x, size.y, size.z) / 2
tri = 0
for o in meshes:
    tri += len(o.data.polygons)
print("[build_sandbox] 尺寸 %.1f x %.1f x %.1f m | 对象 %d | 面 %d"
      % (size.x, size.y, size.z, len(meshes), tri))

# ---------------------------------------------------------------- 世界
world = bpy.data.worlds.new("SandboxWorld")
scene.world = world
world.use_nodes = True
wn = world.node_tree
wn.nodes.clear()
wout = wn.nodes.new("ShaderNodeOutputWorld")
bg = wn.nodes.new("ShaderNodeBackground")
bg.inputs["Color"].default_value = (*P["world"], 1)
bg.inputs["Strength"].default_value = P["world_strength"]
wn.links.new(bg.outputs["Background"], wout.inputs["Surface"])

# ---------------------------------------------------------------- 灯光
sun_data = bpy.data.lights.new("Sun", type='SUN')
sun_data.energy = P["sun_energy"]
sun_data.color = P["sun"]
sun_data.angle = math.radians(P["sun_angle"])
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(52), 0, math.radians(38))
sun.location = (radius * 2, -radius * 2, radius * 4)

fill_data = bpy.data.lights.new("Fill", type='AREA')
fill_data.energy = max(200.0, radius * radius * 1.6)
fill_data.size = radius * 2.2
fill_data.color = P["sky"]
fill = bpy.data.objects.new("Fill", fill_data)
scene.collection.objects.link(fill)
fill.location = (-radius * 1.8, radius * 2.2, radius * 2.4)
d = (Vector((0, 0, 0)) - fill.location)
fill.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

# 天空光（半球）
hemi = bpy.data.lights.new("Hemi", type='SUN')
hemi.energy = 0.5
hemi.color = P["sky"]
hemi.angle = math.radians(60)
ho = bpy.data.objects.new("Hemi", hemi)
scene.collection.objects.link(ho)
ho.rotation_euler = (math.radians(80), 0, math.radians(200))

# ---------------------------------------------------------------- 地面（承接阴影，做出展台感）
bpy.ops.mesh.primitive_plane_add(size=radius * 24, location=(center.x, center.y, mn.z - 0.6))
floor = bpy.context.object
floor.name = "ShowcaseFloor"
fm = bpy.data.materials.new("MAT_Floor")
fm.use_nodes = True
fb = fm.node_tree.nodes["Principled BSDF"]
fb.inputs["Base Color"].default_value = (P["ground"][0]*0.55, P["ground"][1]*0.55, P["ground"][2]*0.55, 1)
fb.inputs["Roughness"].default_value = 0.62
floor.data.materials.append(fm)

# ---------------------------------------------------------------- 相机
from bpy_extras.object_utils import world_to_camera_view

cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 50
cam_data.clip_start = 1.0
cam_data.clip_end = 200000.0
cam = bpy.data.objects.new("Camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

BBOX_CORNERS = [Vector((x, y, z)) for x in (mn.x, mx.x) for y in (mn.y, mx.y) for z in (mn.z, mx.z)]


def aim(az_deg, elev_deg, dist):
    a, e = math.radians(az_deg), math.radians(elev_deg)
    dirv = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
    cam.location = center + dirv * dist
    cam.rotation_euler = (-dirv).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.view_layer.update()


def fits(az, elev, dist, pad=0.012):
    aim(az, elev, dist)
    for c in BBOX_CORNERS:
        uv = world_to_camera_view(scene, cam, c)
        if uv.z <= 0:
            return False
        if uv.x < pad or uv.x > 1 - pad or uv.y < pad or uv.y > 1 - pad:
            return False
    return True


def place_camera(az_deg, elev_deg=34.0):
    """二分搜索距离，让整个沙盘刚好落在画面内"""
    lo = radius * 0.2
    hi = radius * 1.2
    guard = 0
    while not fits(az_deg, elev_deg, hi) and guard < 20:
        hi *= 1.35
        guard += 1
    for _ in range(30):
        mid = (lo + hi) / 2
        if fits(az_deg, elev_deg, mid):
            hi = mid
        else:
            lo = mid
    aim(az_deg, elev_deg, hi)
    cam_data.dof.use_dof = True
    cam_data.dof.focus_distance = hi
    cam_data.dof.aperture_fstop = 11.0
    return hi


dist = place_camera(-118)
print("[build_sandbox] 相机距离 %.1f m" % dist)

# ---------------------------------------------------------------- 渲染设置
try:
    scene.render.engine = A.engine
except TypeError:
    scene.render.engine = 'CYCLES'
if scene.render.engine == 'CYCLES':
    scene.cycles.device = 'CPU'
    scene.cycles.samples = A.samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
else:
    try:
        scene.eevee.taa_render_samples = A.samples
    except Exception:
        pass

scene.render.resolution_x = RES_X
scene.render.resolution_y = RES_Y
scene.render.film_transparent = False
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = A.render

try:
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
except Exception:
    pass
scene.view_settings.exposure = P["exposure"]

# ---------------------------------------------------------------- 保存 + 渲染
os.makedirs(os.path.dirname(os.path.abspath(A.out)) or ".", exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(A.out))
print("[build_sandbox] 已保存 %s" % A.out)

if A.turntable:
    for i, ang in enumerate((-118, -28, 62, 152)):
        place_camera(ang)
        scene.render.filepath = A.render.replace(".png", "_%d.png" % i)
        bpy.ops.render.render(write_still=True)
        print("[build_sandbox] 转盘帧 %d -> %s" % (i, scene.render.filepath))
else:
    bpy.ops.render.render(write_still=True)
    print("[build_sandbox] 已渲染 %s" % A.render)
