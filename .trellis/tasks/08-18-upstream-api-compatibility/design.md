# 设计 - 上游 API 响应兼容层

## 数据流

```text
fetch -> 有界超时/重试 -> ChKSz JSON 响应解码 -> MusicService -> UI 分类提示
```

## 设计决定

- 新增无 DOM、无存储依赖的 `js/chksz-api-response.js`，集中定义 HTTP 错误、状态提示和 JSON 响应读取。
- `js/core-utils.js` 继续负责超时与重试，只调用响应解码器，不在请求循环中重复解析错误体。
- HTTP 状态放在错误对象的数值 `status` 上；服务端 `code` 只保存为短的安全 code，不保存响应原文。
- 用户提示使用固定状态映射和已脱敏的短消息，不将请求 URL、查询参数、响应体或密钥传入诊断记录。

## 兼容性

- 成功响应的 JSON 结构不变。
- 现有 `classifyPlaybackFailure` 继续以 401/403、网络和 5xx 为分类依据。
- 旧测试中只有 `ok/status` 的响应桩继续有效；解码器对缺失 `json()` 做安全降级。
