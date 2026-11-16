# 肥鱼画室 · Chubby fish studio

右侧栏里一张**你和 agent 共用的颜料画布**：真实的 Kubelka–Munk 混色、湿画扩散、六种笔刷；agent 看得见你的画，也能自己落笔，而它落的每一笔都进你的撤销栈。

This is the plugin detail page. Install steps live in the repository README.

## 面板这边

- **入口两处**：左侧栏底部、⚙ 设置旁边的常驻入口（宽栏显示「🐟 肥鱼画室」，收起成 56px 轨道时只剩图标）；以及右侧栏的 `chubby-fish-canvas` 标签类型 + 引导卡片。
- **颜料引擎**：自写的 KM（Kubelka–Munk）混色，32×32×320 的光谱查找表在 WebGL2 里采样；颜料按浓度沉积，纸按湿度扩散，边缘会积水、会往下淌。
- **六种笔刷**：`watercolor` / `dry` / `splatter` / `circle` / `soft` / `flat`；另有涂抹（沿路径把已画的颜色拖开）。
- **笔的参数**：大小、浓度（1–100）、湿度（0–100）、笔压（可开），混色区可手动调色。
- **画布分辨率**：⚙ 弹窗里用滑条或数字输入，480–1000 逻辑宽（680×572 – 1417×1192 px）。它改的是**位图分辨率**，不是显示尺寸；面板永远铺满侧栏，不随窗口缩放。
- **撤销 / 重做 / 保存 PNG / 显示缩放 / 中英切换**：面板自带。

## agent 这边

| 工具 | 能力 |
|---|---|
| `canvas_look` | 画面（图片块）+ 像素尺寸 + 当前笔刷/调色板/颜色 + 撤销位置；必要时附缩放提示 |
| `canvas_state` | 同样的状态，不带图，省 token |
| `canvas_draw` | 多条笔触；每条可单独指定颜色、尺寸、**浓度**、**湿度**、**笔刷材质**、**压感曲线**，或用涂抹；另有 `undo` / `redo` / `clear` |
| `canvas_sample` | 读画布**真实像素**（面板端 `readPixelByte`），用来判断"这块到底多深" |

落笔走的是和手画完全相同的 `drawBrush` 管线；区别只在坐标系：agent 传的是画布像素坐标。

压感按**曲线**响应（`pressureCurve`）：`linear` / `soft`（smoothstep，两端缓）/ `firm`（保宽后收）/ `ink`（早收，像出锋）。默认不放压感——因为低压力同时压低沉积，整幅画都用压感会又淡又薄；收尖只该用在须、鳍尖、线尾这类地方。

## 数据怎么走

**看**：面板把画布缩到长边 ≤900 px、webp 0.92 → `POST /mpx/canvas/push` → 宿主内存 + （600 ms 防抖）落盘到 `<DSH_HOME>/canvas-state/<sessionId>.json` → `canvas_look` 把它作为图片附件交给模型。

**画**：工具调用 → 宿主通过 SSE `GET /mpx/canvas/stream` 下发 `ops` → 面板逐笔落笔（一笔最多摊 16 帧，笔间留 200 ms，每笔一个独立历史帧）→ 面板 `POST /mpx/canvas/done` 回执，工具才返回，所以紧接着的 `canvas_look` 看到的是成品而不是半截。

**问**：`POST /mpx/canvas/ask` 把「面板问题 + 当前画面」作为一条用户消息投给会话。

**取色**：`canvas_sample` 走 `/mpx/canvas/sample`——宿主下发 `sample` op，面板读像素后回传，因为只有面板拿得到精确像素。

## 两种看画节奏

- **手动**（默认）：只有你点「让肥鱼看看」或直接叫它看。
- **实时**：笔触事件先进收件箱，攒够**笔数 / 像素变化 / 冷却时间**三个阈值才触发一次（都能在 ⚙ 里调）。埋点是按笔的，不落笔就不打扰。

每次自动看画都会把最新快照推给宿主，所以即便在实时模式下，模型看到的也是刚画的。

## 会话与存储

- 画布按**会话**隔离：面板的 localStorage 键带 `mpx:<sessionId>:` 前缀，宿主的快照文件按 sessionId 命名。
- 落盘保留：最多 16 个文件 / 30 天，单帧超 4 MB 不落盘；每个文件原地覆盖，画得越久文件不会越大。
- **跨重启不丢**：DSH 每次启动端口会变（浏览器 localStorage 按 origin 隔离），所以挂载时若本 origin 没有存档，面板会 `GET /mpx/canvas/last` 把宿主那帧写回 localStorage 再启动；宿主重启后也会从盘上懒加载。

## 已知限制

- **一次一张画布**：一个会话一张，没有图层、没有选区、没有橡皮擦（清空是整张）。
- **撤销是单线的**：它画的和你画的混在同一条历史里，只能按顺序撤；它在落笔中途你按撤销，会让后面的帧被当作重做分支丢弃。
- **快照是拉取的**：模型只在工具运行时才"看"，不能边画边盯；每次看画消耗一张图。
- **只有 KM 引擎**：上游应用里基于 npm `mixbox` 的那个引擎、桌面宿主桥、更新器、公告弹窗都不在包里。
- **面板不跟随宿主主题**：作画面保持应用自己的深色面板样式；文字语言用应用自己的中英切换。
- **桥是本地环回 HTTP**：路由只在本机 GUI origin 下可达，没有额外鉴权。

## 重新构建客户端

`client.js` 是预构建产物，安装不需要构建。要重新生成需要上游绘画应用的源码（本仓库不分发）：

```sh
node build/build-client.mjs --src <upstream checkout>
```

脚本逐文件注入并施加受断言保护的补丁：上游文件结构一变就报错退出，不会静默产出坏包。

## English summary

A shared painting canvas between you and the agent. The panel hosts a custom
Kubelka–Munk pigment engine with a watercolour pipeline and six brush textures; the agent
gets `canvas_look`, `canvas_state`, `canvas_draw` (per-stroke colour, size, concentration,
wetness, brush texture, pressure curve, smudge, undo/redo/clear) and `canvas_sample`
(exact pixels). Strokes are paced across frames and acknowledged, so a tool call returns
only once the canvas really shows the finished stroke. Snapshots persist to
`<DSH_HOME>/canvas-state/` and are restored on the next launch.
