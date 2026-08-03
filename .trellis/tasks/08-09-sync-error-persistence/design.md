# 设计：同步失败可恢复化——最近错误持久化

## 数据结构

`localStorage['cp_cloud_last_error']`：

```json
{
  "ownerId": "当前登录账号 ID",
  "at": 1720000000000,
  "message": "云同步暂时无法连接，已保留本机数据"
}
```

只保存 `cloudErrorMessage()` 生成的脱敏文本。读取时要求 `ownerId` 与当前会话一致、时间为正数、消息为非空字符串；否则忽略记录，不让异常 JSON 影响播放器启动。

## 生命周期

```text
同步异常
  -> setCloudState('error', message)
  -> 写入 cp_cloud_last_error（ownerId + at + message）
  -> 刷新设置页显示“最近错误”

INITIAL_SESSION / SIGNED_IN
  -> 根据当前 ownerId 读取本机错误
  -> 先保留旧错误展示，再尝试自动同步

同步成功
  -> 清除当前 ownerId 的本机错误
  -> 隐藏最近错误，恢复“立即同步”

SIGNED_OUT / 切换账号
  -> 清理内存中的错误文本
  -> 新账号只读取自己的记录
```

## 账号隔离规则

- 记录中必须带 `ownerId`，读取只接受当前账号。
- 不把错误文本放入共享的云端数据或 `cloud_outbox`。
- 未登录时不显示任何已登录账号的错误；退出后本机记录可保留，便于同一账号下次登录继续恢复，但不能在其他账号会话中显示。

## 兼容与缓存

- 复用现有 `readLocalStorage`、`writeLocalStorage`、`removeLocalStorage` 安全封装。
- `js/app.js` 是 Service Worker 预缓存生产资源，修改后递增 `sw.js` 的缓存版本。\n
