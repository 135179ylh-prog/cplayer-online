# Implementation Plan - 同步状态中心

1. [x] 收尾并归档生产账号启用任务，核对 `8585ca3` 的 Pages 工作流成功。
2. [x] 读取当前账号同步实现、前端质量规范、共享跨层/复用指南和测试矩阵。
3. [x] 增加纯状态投影与最近成功时间格式化单元测试。
4. [x] 扩展现有同步状态 owner：真实 outbox 计数、冲突重算、按账号保存最近
   成功、保留错误，并修正手动同步的完成提示。
5. [x] 在桌面/手机设置入口和账号卡渲染同一状态投影，保持无障碍与 44px
   触控边界；升级 Service Worker cache 和生成 CSS。
6. [x] 增加静态契约与桌面/手机浏览器回归：成功、离线 pending、冲突计数、
   错误重试、刷新恢复、未配置/未登录本地可用。
7. [x] 运行聚焦测试、完整响应式矩阵和独立端口的 `npm run verify`，更新
   Trellis 质量矩阵与维护规范。
8. [ ] 审查 diff 与敏感数据边界，独立提交并推送 `main`，监控 Pages 成功。
9. [ ] 对线上状态中心做只读桌面/手机冒烟，记录提交、运行、版本与回退证据，
   归档任务后才进入真实跨设备验收。

## Validation Commands

```powershell
npm test
npm run check:features
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/responsive-accessibility.spec.mjs
$env:PW_PORT='<unused-port>'; npm run verify
git diff --check
```

`release-artifact.spec.mjs` 不单独裸跑；没有 `PW_WEB_ROOT` 时它会跳过。完整
`npm run verify` 会先构建 `output/pages` 并注入正确根目录。

## Risk Points

- 计数若来自内存推测，会在刷新、离线或账号切换后说谎；必须读真实 outbox。
- 清空旧冲突若发生在半轮失败前，会把未解决冲突从 UI 隐藏；只在整轮完成后
  原子替换当前 owner 的冲突集合。
- 最近成功若在部分完成时写入，会产生危险的“已同步”假象。
- 设置入口新增状态点不能缩小按钮或破坏安全区/横竖屏布局。
