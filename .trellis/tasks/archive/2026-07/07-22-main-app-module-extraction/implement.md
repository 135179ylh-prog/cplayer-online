# Implement - 主应用模块拆分与性能基线

## 执行顺序

1. [x] 记录迁移前文件与模块大小，确认模块标签、import 和经典脚本顺序。
2. [x] 机械提取主模块到 `js/app.js`，替换 HTML 为唯一外部 module 入口。
3. [x] 更新 `check_module_syntax.py` 和 `verify_features.py` 的源码所有权。
4. [x] 更新 Service Worker 核心资源与缓存修订号，强化升级缓存断言。
5. [x] 增加模块资源装载回归，记录迁移后资源大小和请求边界。
6. [x] 更新前端质量规范、任务计划与验证记录。
7. [x] 运行定向检查和完整 `npm run verify`，审查差异与空白。
8. [x] 创建本地工作提交，归档任务并记录 journal；不推送、不部署。

## 验证命令

- `npm run check:module`
- `npm run check:features`
- `npm run check:sw`
- `npx playwright test tests/e2e/app-shell.spec.mjs tests/e2e/service-worker-update.spec.mjs`
- `npm run verify`
- `git diff --check`

## 高风险位置与回退点

- 新文件位于 `js/`，原 `./js/core-utils.js` import 必须变为 `./core-utils.js`。
- `type="module"` 入口必须保留在原位置和原加载顺序，不能改为 async 或经典脚本。
- `tests/verify_features.py` 中 DOM 与业务断言必须分配到真实所有者，不能简单把所有文本永久拼接后掩盖边界错误。
- 生产预缓存资源变化必须提升 Service Worker 缓存版本。
- 不在机械迁移中格式化 6000 行脚本；若出现行为差异，先比较提取前后文本而不是继续打补丁。
