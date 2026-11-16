# 素材与出处 / Credits

## 上游绘画应用

`client.js` 由 Mixbox Palette（本项目作者自己的颜料混色作画应用）的源码在构建期打包生成：

- 打包方式：`build/build-client.mjs` 读取上游源码目录，逐文件注入，并做一组受断言保护的补丁（禁用 WebWorker、内联 LUT、屏蔽调试快捷键等）。
- 上游源码不随本仓库分发。要重新构建，请自备源码并运行 `node build/build-client.mjs --src <源码目录>`。
- 生成的 `client.js` 里包含该应用的运行时代码，其版权归原作者（本仓库作者）所有，按本仓库的 MIT 许可一并提供。

## 图标

工具栏与界面中的部分图标来自 [Bootstrap Icons](https://icons.getbootstrap.com/)（MIT）。原始声明：

- Bootstrap Icons, Copyright (c) The Bootstrap Authors, licensed under MIT.
- 许可全文见上游仓库 <https://github.com/twbs/icons/blob/main/LICENSE>。

插件的 `icon.svg`（叼着笔的胖鱼）由本仓库自行绘制，同样按 MIT 提供。

## 颜料混色引擎

KM 混色查找表与内核来自上游应用自写的实现（不使用 npm 上的 `mixbox` 包），随 `client.js` 一并分发。
