# GeoSandbox · OpenStreetMap + three.js + Blender 三维沙盘工具

一句话：**在浏览器里框一块地方 → 自动拉 OSM 建筑/道路/水系/绿地 + DEM 地形 → 实时三维沙盘 → 一键导出 GLB 交给 Blender 出图。**

浏览器端是 React 18 + three.js（@react-three/fiber），数据全部来自免费无 key 的公开服务；Blender 端是一个 Python 脚本，负责把导出的 GLB 变成可出图的场景。

---

## 1. 目录结构

```
geo-sandbox/
├─ index.html
├─ vite.config.ts           # dev 代理（地形瓦片 / Overpass）
├─ package.json             # dev / build / preview / serve / blender
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx               # 状态编排：区域 → 数据 → 几何 → 导出
│  ├─ styles.css
│  ├─ components/
│  │  ├─ Viewport.tsx       # R3F Canvas + 光照/雾/相机/OrbitControls
│  │  └─ AreaPicker.tsx     # MapLibre 选区（OpenFreeMap 矢量底图）
│  └─ lib/
│     ├─ geo.ts             # EPSG:3857 投影 → 局部米制坐标（1 单位 = 1 m）
│     ├─ vectortiles.ts     # OpenFreeMap 矢量瓦片（OpenMapTiles schema）→ 要素
│     ├─ overpass.ts        # Overpass 备用取数通道（可选数据源）
│     ├─ terrain.ts         # Terrarium DEM 瓦片 → 高程网格
│     └─ sceneBuilder.ts    # 要素 → three.js BufferGeometry（合并 + 顶点色）
├─ server/index.mjs         # 生产模式：静态托管 dist + 同源代理
├─ scripts/blender.mjs      # 定位 blender.exe 并调用出图脚本
├─ blender/build_sandbox.py # GLB → 灯光/相机/渲染/保存 .blend
├─ scripts/gh.mjs           # GitHub 发布 CLI（REST API：create/push/pages/status/list）
├─ src/lib/github.ts        # 浏览器端从仓库导入 GLB（Git Data API）
└─ sample/                  # 一份导出的样例（sandbox.blend / sandbox.png）
```

## 2. 环境与启动

```bash
cd geo-sandbox
npm install
npm run dev          # http://127.0.0.1:5178
```

生产模式（单进程，自带代理，可给同事用）：

```bash
npm run build
npm run serve        # http://127.0.0.1:5179
```

URL 参数可直接指定视图：`?preset=night`、`?preset=dusk`、`?view=top`。

## 3. 数据源（都不需要 API Key）

| 用途 | 服务 | 说明 |
|---|---|---|
| 二维底图/选区 | `https://tiles.openfreemap.org/styles/liberty` | OpenFreeMap 托管的全量 OSM 矢量瓦片，CORS 开放 |
| 三维要素 | `https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf` | OpenMapTiles schema：`building`/`transportation`/`water`/`waterway`/`park`/`landcover`/`landuse` |
| 地形 | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Terrarium 编码，`h = R*256 + G + B/256 - 32768` |
| 备用要素源 | Overpass API | 侧栏「数据源」切换，需要网络能直连 Overpass 镜像 |

**关键约束**：OpenFreeMap planet 瓦片最高只到 **z14**，z15 以上返回 0 字节空 tile；`vectortiles.ts` 里的 `pickZoom()` 已把上限锁在 14，并自动按范围大小降级（≤4×4 瓦片）。

## 4. 坐标与几何约定

- 全流程用 **EPSG:3857 米制**，以框选区中心为原点：`+X = 东`，`+Z = 南`，`1 单位 = 1 米`，Y 向上。
- 高程直接来自 DEM，`地形起伏倍率` 可整体压缩/夸张（沙盘常见 1.5–3×）。
- 建筑高度优先级：`height` → `render_height`（矢量瓦片自带）→ `building:levels × 3.2` → 按类型默认值。
- 所有要素都用 **Sutherland–Hodgman / Liang–Barsky** 裁到框选区边界，所以沙盘边缘是干净的切边，不会拖出框外的几何。
- 同类几何合并成一个 `BufferGeometry`（顶点色区分建筑色调），一次 draw call，几千栋建筑也不掉帧。

## 5. 界面功能

- **选择区域**：MapLibre 地图（OpenFreeMap 底图），拖动改中心、滑杆改边长（200–3000 m）、6 个城市预设，绿色框即沙盘范围。
- **图层**：建筑体块 / 道路铁路 / 水体 / 绿地 / 沙盘底座 / 线框，全部实时开关。
- **参数**：建筑高度倍率、地形起伏倍率（改参数只重建几何，不重新联网）。
- **视图**：白天 / 黄昏 / 夜景，轴测 / 俯视。
- **导出**：`导出 GLB`（模型 + 单位米，Y 上）、`导出 GeoJSON`（原始要素，便于 QGIS/Blender GIS 再加工）、`复制 Blender 导入命令`。

## 6. Blender 端

```bash
# 一次跑完：导入 GLB → 打灯/机位 → 保存 .blend → 渲染 PNG
npm run blender -- --glb geo-sandbox.glb --out sandbox.blend --render sandbox.png
```

可选参数：

| 参数 | 含义 | 默认 |
|---|---|---|
| `--glb` | 输入的 GLB（网页导出后放项目根目录） | `geo-sandbox.glb` |
| `--out` | 输出的 .blend | `sandbox.blend` |
| `--render` | 输出的 PNG | `sandbox.png` |
| `--engine` | `CYCLES` / `BLENDER_EEVEE_NEXT` | `CYCLES` |
| `--samples` | 采样数 | 64 |
| `--res` | 分辨率 `WxH` | `1600x900` |
| `--preset` | `day` / `dusk` / `night` | `day` |
| `--turntable` | 1 = 出 4 个机位 | 0 |

Blender 可执行文件查找顺序：`BLENDER_PATH` 环境变量 → `D:\Blender\*\blender.exe` → `C:\Program Files\Blender Foundation\...`。本机实测路径：`D:\Blender\blender-4.2.1-windows-x64\blender.exe`。

脚本做的事：`import_scene.gltf` → 世界/太阳/补光/半球光 → 展台地面 → **相机自动构图**（对包围盒 8 个角做二分搜索，保证整个沙盘入画）→ AgX 色调映射 → 保存 + 渲染。

## 7. 已踩的坑（省你时间）

1. **Overpass / openstreetmap.org 在本机网络不可达** → 全部改走 OpenFreeMap 矢量瓦片。若你的网络能直连 Overpass，可在侧栏切换数据源。
2. **z15 瓦片是空的** → 见 §3，`pickZoom` 上限 14。
3. **不裁剪会拖出框外 2.4 km 几何** → 必须按 bbox 裁多边形和折线，否则相机永远"在模型内部"。
4. **地形网格法线朝下** → 索引绕序写反会让整块地面全黑（`idx.push(a, a+n+1, a+1, …)` 才是正面朝上）。
5. **Blender 相机默认 `clip_end = 100 m`** → 导入几百米宽的沙盘会渲染出一片空白；`build_sandbox.py` 里已设为 200000。
6. **相机自动构图**不能只按 `半径×3` 估距离，透视下的角点会出画；改成对 8 个包围盒角做投影二分。

## 8. GitHub 集成

> 本机网络实测：`api.github.com` ✅、`codeload.github.com` ✅，`github.com` / `raw.githubusercontent.com` ❌。
> 所以整套集成**只走 REST API**，不依赖网页端和 `git push`。

### 8.1 准备 token（一次）

1. 浏览器打开 https://github.com/settings/tokens → **Generate new token (classic)**
2. Note 随便写，Expiration 选 90 days，勾选 **`repo`**（要自动开 Pages 再勾 **`workflow`**）
3. 点 Generate，**复制**那串 `ghp_...`（只显示一次）
4. 回到项目目录，token 还在剪贴板里的话直接：

```bash
cd E:\blander\geo-sandbox
npm run gh -- token --clip        # 读剪贴板 → 写 .github-token → 调 /user 验证
```

不想用剪贴板就 `npm run gh -- token --set ghp_xxxxxxxx`。
脚本会打印 `验证通过: <你的登录名>`，说明 token 有效且认得出你的账号。

### 8.2 发布（一条命令）

```bash
npm run gh publish --repo <你的用户名>/geo-sandbox
```

它按顺序做完：查重 → 建仓库 → `npm run build` → Git Data 提交 → 开 Pages → 打印仓库与站点地址。

要拆开手动执行也可以：

```bash
npm run gh status                       # 看 token / 限额 / 身份
npm run gh create --name geo-sandbox    # 建仓库（--private 可建私有）
npm run build                           # 生成 dist（已设 base:'./'，可直接给 Pages 用）
npm run gh push --repo <用户名>/geo-sandbox
npm run gh pages --repo <用户名>/geo-sandbox
```

`push` 的实现在 Git Data API 上：逐个文件 `POST /git/blobs`（base64，4 并发）→ `POST /git/trees` → `POST /git/commits` → `PATCH /git/refs/heads/main`。**一次提交、大文件不受 contents API 的 1 MB 限制**，也不碰 `github.com`。

推送时自动跳过：`node_modules`、`.git`、`*.blend`、`.github-token`、`_*.log`；默认**包含 `dist/`**（Pages 需要），加 `--no-dist` 可排除。

Pages 打开后地址是 `https://<用户>.github.io/geo-sandbox/`。静态站没有 `/api` 代理，但所有数据源都是直连的公开服务，功能不变。

### 8.3 在网页里导入仓库里的模型

侧栏 **GitHub** 区块：

- 填 `owner/repo/路径.glb`（也接受 `https://github.com/o/r/blob/main/x.glb`）
- 点「从 GitHub 导入」→ `GET /git/trees?recursive=1` 找 blob sha → `GET /git/blobs/{sha}` 取 base64 → `GLTFLoader.parse()`
- 私有仓库在下面的 PAT 输入框填 token（存 localStorage，只发往 api.github.com）
- 「切回本地」恢复到实时生成的沙盘
- 也可以直接用链接分享：`http://127.0.0.1:5178/?gh=owner/repo/发布好的.glb`，打开即自动导入

实测（未登录、匿名限额内）：`KhronosGroup/glTF-Sample-Assets` 的 `Models/Duck/glTF-Binary/Duck.glb` 2.2 s 取回 120,484 字节，`glTF` magic 校验通过。

### 8.4 本机验证结果

| 检查 | 结果 |
|---|---|
| `npm run gh status` | ✅ 读到限额 `core 57/60` |
| `npm run gh list --repo octocat/Hello-World` | ✅ 列出 `README` |
| `npm run gh push`（无 token） | ✅ 正确报错退出（不被静默吞掉） |
| tree → blob → GLB 全链路 | ✅ 120 KB 模型完整取回 |
| `npm run build` + 静态托管 | ✅ `dist/index.html` 用 `./assets/...` 相对路径 |

建仓/推送最后一步需要你的 token —— 这是唯一需要你亲手做的动作。

## 9. 已知限制

- 建筑只有体块+顶点色，没有立面纹理与屋顶结构（矢量瓦片不带）。
- 矢量瓦片 z14 的建筑是"整栋轮廓"，故宫这类密集院落会比 OSM 原始精度粗一些；需要更精细时可切 Overpass 数据源（若网络可达）。
- 树木/POI/路灯等点位图层未渲染（沙盘场景里价值低、量级大）。
