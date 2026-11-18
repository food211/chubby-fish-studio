# 录制与导出

## 两条路，同一个目录

1. **模型录制**：`canvas_record` `{action:"start"}` → 画 → `{action:"stop"}`。停止时片段上传给宿主、写盘、按面板设置导出，返回文件路径。
2. **用户自己录**：面板状态栏最左的 **●** 开始/停止。停下后片段同样上传给宿主，写进同一个目录、走同一套导出格式。

两种录制共用面板设置的保存位置。DSH 默认写入 `<DSH_HOME>/canvas-recordings/`，独立 MCP 默认写入画室数据目录下的 `canvas-recordings/`。具体文件名和格式以停止录制时返回的路径为准。用户从面板录制时，宿主联系不上会退回浏览器下载。

## 录制器怎么工作

- 抓的是**画布流**（`canvas.captureStream`），不是撤销栈——撤销栈只留约 50 帧，只能重放一小段。
- 只在**真的落笔**的帧上推帧，画面静止时把编码器 `pause()` 掉。所以停顿不占时长、不撑大文件；一段 40 秒的作画过程，成片可能只有 12 秒。
- 因此录制前**不要先画**：`start` 之后再落第一笔，成片才是从空白开始。

## 导出格式（面板设置）

| 选项 | 结果 | 依赖 |
|---|---|---|
| `both`（默认） | webm + mp4 | mp4 需要宿主有 ffmpeg |
| `webm` | 只留 webm（会补时长索引） | 补索引也需要 ffmpeg |
| `mp4` | 转成 mp4 后**删掉** webm | ffmpeg |
| `gif` | 转成 gif 后**删掉** webm（fps 12、宽 680、调色板抖动） | ffmpeg |

没有 ffmpeg 时不会失败，只是留下没有时长索引的 webm——播放器可能显示未知时长，用 `ffmpeg -i in.webm -c copy out.webm` 修。

## 宣传用的裁剪配方

README 里那段水母/头像 GIF 是这么来的（3 倍速 + 末帧停 1 秒）：

```bash
ffmpeg -y -i in.gif \
  -vf "setpts=PTS/3,fps=12,scale=680:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -final_delay 100 -loop 0 out.gif
```

- `-final_delay` 单位是 1/100 秒（100 = 停 1 秒）。
- **别用 Pillow 改 GIF 的帧延时**：会重排调色板，文件暴涨甚至丢帧。
- 录制器已经切掉了静止段，**不要再加 `mpdecimate`**，它会把水彩的慢渐变也吃掉。
- 想在结尾补一帧"盖章后"的静帧：把静帧当第二路输入 `-loop 1 -t 1.5 -i still.png`，和主片 `concat` 后一起走 palette 两遍。
