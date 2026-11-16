# 🐟 肥鱼画室 · Chubby fish studio

**一个你和 AI 一起画画的 DeepSeek Harness 插件。** 右侧栏里有一张真的画布：真实的颜料混色、真实的湿画扩散。你画，它看得见；它画，你随时撤销。

不是"把一张图发给模型看看"，而是**同一支笔、同一张纸**——大肥鱼用的是你面板上那套颜料引擎，走的也是那条落笔管线。

MIT · v0.2.0 · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件

---

## 它解决的是什么

普通人用 AI 画画，来回路上一句话："帮我改一下这个" → 生成一张新图 → 你再说 → 又一张新图。中间那一笔一划是断的。

在肥鱼画室里，这个循环是连续的：

- **你画一笔**，它在旁边看着（手动说一声，或者开实时，攒够笔数它自己看）
- **它说一句话**，然后**直接在你的画上落一笔**示范——不是生成新图，是在你的画上叠一笔
- **不满意就撤销**：它画的每一笔都进你的撤销栈，和你的笔触没有区别
- **它能读像素**：不是隔着缩略图猜"这块挺红的吧"，而是精确读到 `#94364F`

所以它不会说"建议你把这里加深一点"，而会说"你这块偏灰，我给你在这叠一笔湿的看看"，然后真的画上去。

## 看一眼它画的东西

下面三张都是在这个画布里、用面板上那台引擎画的（`docs/gallery/`）：

| | |
|---|---|
| ![竹林](docs/gallery/bamboo.webp) | ![风景](docs/gallery/landscape.webp) |
| 竹子：前方两根用 `flat` 方头笔求"实"，后方用 `watercolor` 求"虚"，同一台引擎两种材质 | 风景：大笔横扫的水洗，山脚那些垂线是 100% 湿度下滴水 pass 真的在往下淌 |
| ![花](docs/gallery/flower.webp) | |
| 小花：花瓣根部叠了第二层更深的颜色做厚度 | |

## 安装

在 DSH 的 **Plugins** 页面，安装这个包：

```
github:food211/chubby-fish-studio
```

或者克隆到本地，装**目录**（绝对路径）：

```bash
git clone https://github.com/food211/chubby-fish-studio.git
# Plugins → 安装 → 填 <克隆到的绝对路径>
```

装好后，**左侧栏底部、⚙ 设置旁边**会出现 **🐟 肥鱼画室**；点它就在右侧栏打开画布。不需要先开一个对话。

> 需要 DSH 0.2.x。插件由 Host（工具 + 桥接）和浏览器（面板）两半组成，两者版本必须一致。

## 一起画

打开画布后，正常说话就行。它手里有四把工具（全部只作用于当前会话的画布）：

| 工具 | 它用来做什么 |
|---|---|
| `canvas_look` | 看一眼：画面、画布像素尺寸、当前笔刷/调色板/颜色、撤销位置 |
| `canvas_draw` | 落笔：多条笔触，每条可单独指定颜色、尺寸、**浓度**、**湿度**、笔刷材质，或用涂抹；也能 `undo` / `redo` / `clear` |
| `canvas_sample` | 读准确像素色值（不靠猜） |
| `canvas_state` | 只读状态，不传图，省 token |

对话里可以这么说：

- 「看看我画的」→ 它调 `canvas_look`，给一句具体的观察
- 「这块太闷了，示范一下」→ 它先说一句问题，然后**落一两笔**给你看，你 `Ctrl+Z` 就能撤
- 「帮我把这片天空改成傍晚」→ 它会先取色确认现状，再叠色
- 「我在画竹林，你别动」→ 就不会有自动看画打断你

### 两种节奏

| 模式 | 什么时候看画 | 适合 |
|---|---|---|
| **手动**（默认） | 只有你点「让肥鱼看看」或叫它看，它才看 | 想安静画，或 AI 主动插话会打断你 |
| **实时** | 笔触先进收件箱，攒够**笔数 / 像素变化 / 冷却时间**三个阈值才看一次 | 想要它一边画一边提意见 |

三个阈值都能在 ⚙ 里改。事件是**按笔埋点**的，不是定时轮询——你不落笔，它就一直不打扰。

## 水彩模拟，真在哪

这是这个插件的底盘。它不是"把数值乘个透明度"的水彩**滤镜**，而是一条真的画布管线：

### 颜料按 Kubelka–Munk 混，不是 RGB 平均

蓝 + 黄出绿，是由颜料本身的光学系数算出来的，不是 `(0,0,255)+(255,255,0)` 那种灰白结果。白色混进红色是变粉，不是变灰；一堆半透明颜料叠在一起会真的越叠越深。引擎用预先烘好的 KM 查找表，落笔时按"当前颜料浓度 + 纸面已有的颜色"实时解算。

### 纸是湿的，颜料会走

- **浓度（1–100%）**：一笔能沉积多少颜料。低于 30% 基本等于"污染"纸面，几乎看不到颜色
- **湿度（0–100%）**：纸有多湿。100% 时边缘会持续向外渗，笔触互相吃色；20% 时边缘收得住，接近实线
- **湿边 / 滴水**：湿画时会自然形成深色水痕边缘，纸吸饱了还会往下淌

这是实测的（77% 浓度、100% 湿度、水彩笔）：

| 画进去的颜色 | 画布上的实际像素 | 说明 |
|---|---|---|
| `#C9525F` | `#E58899` | 只沉积了约六成，其余是水 |
| `#9C2542`，浓度 100 / 湿度 40 | `#94364F` | 浓度拉满、湿度收住，几乎原色 |
| `#9C2542`，浓度 20 / 湿度 40 | 几乎读不到红色 | 20% 只是薄薄一层染色 |

所以"为什么我画不深"通常是浓度和湿度，不是笔法。

### 六种笔刷材质，两种落笔方式

`watercolor`（湿、渗、散点纹理） · `dry`（干笔飞白） · `splatter`（喷溅） · `circle`（硬边圆） · `soft`（柔边） · `flat`（方头平涂，边缘利落）

加上**涂抹**：把已经画上去的颜色沿着路径拖开，用来软化边缘、揉开笔刷纹理。涂抹同样进撤销栈。

### 落笔是按帧推进的

手画一支笔，是每一帧打几个点、刷一次屏幕，湿纸和滴水这些 pass 每一帧累积一次。插件画的时候也这么做（一条笔触最多约 40 帧，0.5 秒左右画完），所以它在画布上留下的笔触和你手画走同一条管线——而不是"啪"一下糊上去一片。

## 面板操作

| 操作 | 作用 |
|---|---|
| 左键 / 右键点颜料 | 设为前景色 / 背景色 |
| Alt + 左 / 右键点画布 | 从画面取色 |
| 大小 / 浓度 / 湿度 滑条 | 笔刷尺寸、颜料浓度、纸面湿度 |
| 笔刷按钮 | 六种材质切换 |
| 笔压 | 手写笔压感（鼠标画的时候关着更稳） |
| 混色区 | 拖颜色进去手动调，旁边滑条调混合强度 |
| 保存按钮 | 把当前画面存成 PNG |
| ⚙ | 画布分辨率：滑条或直接输数字（480–1000 逻辑宽，对应 680–1417 px 位图） |
| ↻ | 刷新面板（会先保存画面），或重载整个界面 |
| 顶部 100% | 显示缩放，不影响画布分辨率 |
| 右下角「手动 / 实时」 | 点一下切换看画模式，点开时事件收件箱会清空 |

## 数据在哪

- **画布快照**：`<DSH_HOME>/canvas-state/<sessionId>.json`，每个会话一个文件、**原地覆盖**
- **保留**：最多 16 个文件 / 30 天，单帧超 4 MB 不落盘
- **跨重启**：DSH 重启后端口会变（浏览器 localStorage 按 origin 隔离），插件会把上一帧写回，所以画不会丢
- **不联网**：颜料引擎、混色表、笔触全部在本地跑；画布只在你和这个会话的 agent 之间流转

## 从源码构建

`client.js` 是**预构建产物**，安装不需要构建。要自己重新生成，需要上游绘画应用的源码（本仓库不分发）：

```bash
node build/build-client.mjs --src <上游源码目录>
# 或 MPX_SRC=<目录> node build/build-client.mjs
```

构建是**逐文件注入 + 受断言保护的补丁**：上游文件结构一变就报错退出，不会静默产出坏包。产物里已经清掉了上游的桌面宿主相关代码与文案（导入按钮、UI 文案、更新提示）。

## 已知限制

- 一个会话一张画布，没有图层、没有选区、没有橡皮擦（清空是整张）
- 面板宽度由右侧栏决定，画布永远铺满它；改的是**分辨率**，不是显示尺寸
- AI 只能一笔一笔落笔，不会"一键生成一张图"——这是刻意的
- 中文/英文界面跟随浏览器语言，面板内也可以手动切
- 撤销栈是单线的：它画的和你画的混在一条历史里，只能按顺序撤

## 许可

MIT，见 [LICENSE](LICENSE)。上游应用与第三方图标的归属见 [docs/CREDITS.md](docs/CREDITS.md)。

---

## English

A DeepSeek Harness plugin for **painting together with the agent** on one canvas in the
right sidebar.

- **Real pigment mixing** through a Kubelka–Munk engine (blue + yellow actually turns
  green), a watercolour pipeline with concentration, paper wetness, wet edges and drips,
  and six brush textures including a smudge tool.
- **The agent paints on your canvas.** `canvas_look` shows it the picture,
  `canvas_draw` lays strokes with per-stroke colour, size, concentration, wetness and
  brush material, and `canvas_sample` reads exact pixels. Every agent stroke lands in
  your undo stack.
- **Two tempos**: manual ("let the fish look") or realtime, where stroke events queue in
  an inbox and only trigger a look once the stroke count, pixel-change and cooldown
  thresholds are met.
- **Survives restarts**: snapshots are written to `<DSH_HOME>/canvas-state/` and restored
  on the next launch, even though the GUI port — and therefore the browser origin —
  changes between runs.

Install from the **Plugins** page with `github:food211/chubby-fish-studio`, then click
**🐟 肥鱼画室** at the foot of the left sidebar. MIT licensed.
