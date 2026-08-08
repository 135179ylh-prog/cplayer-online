# 提取一个模块的检查清单

每次从 `js/app.js` 搬出一块代码都要走完这 6 步。漏任何一步会让门禁失败，
或者更糟：静默失效（密钥扫描盲区、Tailwind 类名被清除）。

## 必做 6 步

1. **建 `js/<new>.js`**，用命名导出。导入同级模块写 `'./core-utils.js'`，
   不要写 `'./js/core-utils.js'`。
2. **在 `js/app.js` 顶部加 import**，路径是 `'./<new>.js'`。
3. **`scripts/pages-contract.mjs`** 的 `CORE_ASSETS` 加 `'./js/<new>.js'`。
   这是预缓存资源的唯一真源。
4. **`sw.js`**：在 `CORE_ASSETS` 相同位置加相同条目（2 空格缩进，顺序必须与
   `pages-contract.mjs` 完全一致，契约用 `JSON.stringify` 逐项比对）；
   递增 `CACHE_NAME` 版本号；粘贴重算后的 `PRECACHE_REVISION`。
   重算方法：直接跑 `npm run build:pages`，它会报出期望值。
5. **`tests/verify_features.py`** 五处：
   - 加文件读取常量（比照 `CORE_UTILS`）
   - 加 `is_file()` 存在断言和 `in SW` 预缓存断言
   - 加进 `production_source` 元组 —— **漏这步会造成密钥扫描盲区**
   - 把搬走的 `in APP` 断言改指向新模块
   - 加模块边界断言（不发布全局、不反向依赖应用状态）
6. **`tests/e2e/release-artifact.spec.mjs`** 的 `PUBLIC_PATHS` 加 `'/js/<new>.js'`。

## 视情况

- **`tailwind.config.cjs`**：仅当搬走的代码含 Tailwind 类名字符串时加进 `content`。
  漏了不会报错，但类名会被清除 —— 是静默的视觉回归。
- **`tests/<new>.test.mjs`**：可选单元测试，`test:unit` 自动 glob，无需注册。

## 确认无需改动（已核实）

- `scripts/build-pages-artifact.mjs`：`PAGE_DIRECTORIES` 递归拷贝 `js/`，
  且 `CORE_ASSETS` 从契约导入。
- `scripts/check-rollback-target.mjs`：自动发现 `.js`/`.mjs` 并跟随静态 import。
  但新模块必须能被 acorn 解析。
- `scripts/check-pages-release.mjs`、`tests/release-preflight.test.mjs`：
  都从 `pages-contract.mjs` 派生。
- `tests/e2e/service-worker-update.spec.mjs`：资源数量断言是下限式，容忍增长。
- `index.html`：`app.js` 是唯一 `type="module"` 入口，新模块由它 import，
  不需要加 script 标签。

## 高危点

- `tests/verify_features.py` 有一条 `APP.count("localStorage.") == 3` 的**精确
  相等**断言。一旦把存储边界相关代码搬出 `app.js`，计数会变成 0 并失败。
  搬那块时必须同步改这条。
- 新模块加入 `CORE_ASSETS` 一定会改变预缓存哈希，所以第 4 步的两个值必须一起更新。
