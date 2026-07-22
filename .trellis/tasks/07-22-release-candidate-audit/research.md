# Research - 发布候选审计与交付

## 2026-07-22 当前证据

- 最新主模块任务完整门禁：8/8 层通过；82 个 Playwright 用例中 80 通过、2 个预期跳过。
- 关键视口：`1280x800`、`390x844`、`355x800`、`440x707`。
- 已归档验证文件共 11 份，后续里程碑已补齐最初质量矩阵中队列、备份、歌单、最近播放、播放失败和旧缓存升级的弱项。
- 当前 Service Worker 为 `cplayer5-v56-main-app-module`，核心资源 11 个。
- Pages workflow 先运行 `npm run verify`，成功后才复制 HTML、manifest、playlist、Service Worker、CSS、fonts、img、js 和 webfonts。
- 本机 Playwright 1.61.1 只安装 Chromium；CI 也只安装 Chromium。项目主要目标设备为华为 Android，WebKit/Firefox 不在当前自动发布门禁。

## 发现

- `manifest.json.description` 的“超清母带”与真实音质契约不一致，应在发布候选中修正。
- 当前自动化无法证明 Android/HarmonyOS 的后台存活、锁屏媒体通知、蓝牙按键或系统省电策略；这些必须留给实体设备。
- 当前自动化也不能替代 TalkBack 实际播报顺序，但 Axe、焦点圈定、键盘和可访问树状态已覆盖浏览器层基础。

## 发布边界

- 本任务可以完成本地稳定候选、说明、回退和可执行手测清单。
- 未经用户确认不能 push 或部署，因此远端 GitHub Actions、线上 Pages 更新和实体设备手测结果不属于本轮已完成证据。
