# 正式启用账号与歌单云同步

## Goal

把已经完成并通过本地测试的可选账号系统连接到用户现有的 Supabase
Free 项目，并发布到 GitHub Pages。用户登录后可同步自建歌单；未登录时
播放器仍保持现有的本地使用方式。

## Requirements

- 继续使用现有 Supabase Free 项目，不升级套餐、不绑定付费能力。
- 在 Supabase 执行已审查的迁移，创建逐用户隔离的歌单表、RLS 策略和
  乐观版本 RPC；执行前必须再次取得用户明确确认。
- Authentication 的 Site URL 和允许跳转地址必须指向正式 Pages 站点。
- 网页只发布 HTTPS 项目 URL 和 Supabase 明确允许公开的 publishable key。
  secret、service-role 或管理员密钥不得被读取、复制、提交或输出。
- `js/cloud-config.js` 成为生产配置；Service Worker 缓存版本随预缓存资源
  变更而升级。
- 静态检查既要允许有效的生产公开配置，也要拒绝 HTTP 地址和管理员密钥。
- ChKSz API 密钥、API 地址、播放进度、当前队列、最近播放和设备设置继续
  只保存在本机，不进入云同步。
- 发布前运行完整 `npm run verify`；推送 `main` 后监控 Pages 部署并做线上
  未登录冒烟验证。自动化不得创建虚假真实用户。

## Acceptance Criteria

- [x] Supabase 迁移成功，RLS、RPC 和权限对象存在且无破坏性数据删除。
- [x] 正式站点 URL/Redirect URL 配置正确。
- [x] Pages 产物包含有效 HTTPS 项目 URL 和 publishable key，且不含管理员密钥。
- [x] 未登录打开网页时账号入口可用，本地播放与本地歌单不受影响。
- [x] 完整质量门禁通过，生产缓存版本与配置断言同步更新。
- [ ] `main` 推送成功，GitHub Pages 工作流成功，线上站点加载新版本。
- [ ] 任务文档记录实际命令、测试计数、部署证据和回退方式。

## Out Of Scope

- 代替用户创建真实播放器账号或保存用户密码。
- 同步音乐 API 密钥、播放记录、队列、播放进度或设备设置。
- 付费套餐、社交功能、公共歌单广场和管理员后台。
