# Design - 主应用模块拆分与性能基线

## 1. 运行时边界

```text
index.html
  -> 经典脚本 js/color-thief.umd.js
  -> 经典脚本 playlist.js
  -> ES module js/app.js
       -> import ./core-utils.js
```

`js/app.js` 继续使用 `type="module"`。浏览器会并行获取模块，但在 HTML 解析完成后执行，所以脚本标签后方的设置、资料库和歌单详情 DOM 仍在初始化前可用。经典脚本保持原有顺序，避免改变 `ColorThief`、`loadPlaylistFromUrl` 等全局依赖。

本任务采用机械提取：取现有模块标签的完整文本作为新文件，只把 `./js/core-utils.js` 改为 `./core-utils.js`。不在迁移中顺带重构函数、格式或注释。

## 2. 验证来源

`tests/verify_features.py` 使用三个明确来源：

- `HTML`：DOM、viewport、样式入口和模块标签。
- `APP`：播放器业务、存储、API、PWA 注册与交互函数。
- `PRODUCTION_SOURCE`：需要扫描硬编码密钥等跨文件风险时组合生产文件。

`scripts/check_module_syntax.py` 直接读取并检查 `js/app.js`。这样被检查的就是发布文件，不再存在“临时提取文本与生产装载入口不同步”的间接层。

## 3. 缓存与升级

`sw.js` 的核心资源增加 `./js/app.js`，缓存名提升为 `cplayer5-v56-main-app-module`。本地资源继续使用现有缓存优先策略；版本提升确保已安装 PWA 不会长期保留缺少主模块的新 HTML/旧缓存组合。

Service Worker 升级回归在旧 Worker 激活后打开真实应用，并确认新缓存同时包含 `/index.html`、`/js/app.js` 与其他核心资源。随后离线刷新，现有 `waitForAppReady` 证明外置模块真实执行。

## 4. 性能证据

迁移只改变资源切分，不改变总代码量。验证记录同时列出：

- `index.html` 字节数；
- `js/app.js` 字节数；
- 两者合计；
- Playwright 首次导航观察到的 `/js/app.js` 请求次数和响应类型。

HTML 体积明显下降是可验证结果；首次加载速度是否更快受 HTTP、磁盘和 Service Worker 状态影响，不作为本任务结论。

## 5. 兼容与回退

- 没有数据迁移，IndexedDB/localStorage 完全不变。
- Pages 已复制 `js/` 目录，无需增加第二份发布文件清单。
- 回退时恢复内联模块、旧语法检查和旧缓存名即可；Service Worker 更新流程会切回对应核心资源集合。
- 最大风险是 import 相对路径或缓存清单遗漏，分别由直接语法检查、模块请求回归和离线升级回归覆盖。
