# Implementation Plan - 真实跨设备验收

1. [x] 确认同步状态中心已归档，`main == origin/main`，Pages 运行
   `30032507265` 成功。
2. [x] 建立真实设备、测试数据、凭据边界、停止条件和清理方案。
3. [x] 在设备 A 创建唯一测试歌单并记录基线、歌曲 id 与初始顺序。
4. [x] 由用户在设备 B 登录/同步，完成 A→B 与 B→A 顺序传播。
5. [x] 在设备 B 完成真实离线编辑与联网 outbox 恢复。
6. [x] 制造 B 离线旧版本 vs A 在线新版本，记录冲突前双方数据并显式解决。
7. [x] 双端收敛后删除测试歌单，确认非测试数据未改变并记录 tombstone 风险。
8. [x] 运行桌面/手机聚焦回归与完整 `npm run verify`，更新验证矩阵。
9. [ ] 独立提交/推送验收证据，监控 Pages 并线上只读复核，归档任务。

## Validation Commands

```powershell
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium
$env:PW_PORT='<unused-port>'; npm run verify
git diff --check
```

## User Touchpoints

手机步骤每次只给一个动作，并先说明预期状态。用户无需运行命令；只需在
正式网页中登录、打开设置/资料库、切换网络和调整专用测试歌单。任何密码
都留在手机输入框，不通过聊天发送。
