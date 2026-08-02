# Implementation Plan - 冲突差异预览

1. [x] 读取长期 Goal、回收站/历史任务和前端质量规范，确认现有冲突选择与数据边界。
2. [x] 在 `js/cloud-sync.js` 增加可测试的 `diffPlaylistContent` 合同。
3. [x] 在 `index.html` 增加冲突差异预览容器，保持现有两种处理按钮。
4. [x] 在 `js/app.js` 接入差异渲染、空状态和异常降级。
5. [x] 补充单元测试、账号云同步桌面/手机测试和静态功能合同。
6. [x] 运行 `npm run verify`，更新验证记录与必要的前端规范。
7. [ ] 独立提交、推送，等待 Pages 部署后完成桌面/手机线上验收。

## Validation commands

```powershell
npm test
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium
npm run verify
git diff --check
```
