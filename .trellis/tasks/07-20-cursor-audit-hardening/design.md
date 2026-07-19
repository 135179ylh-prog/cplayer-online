# Design - 审计加固

## 设计原则

沿用当前单页模块脚本和现有 `showToast`、`fetchJsonWithTimeout`、`normalizeSongObject` 等入口，不引入新的运行时框架。所有外部 API 仍使用已验证的 `https://api.chksz.top/api`。

## 网络层

- `ChKSzAPI.baseUrl` 作为唯一基础地址。
- `fetchJsonWithTimeout` 增加可选重试策略：只对网络异常、超时和 HTTP 5xx 重试；指数退避上限很小，避免搜索输入造成请求风暴。
- 每次请求都清理 AbortController 定时器；最终错误保留用户可读信息。
- `MusicService` 从 `ChKSzAPI.baseUrl` 读取地址，不再复制字符串。

## 反馈层

- 页面加载后注册一次 `online`/`offline` 监听器。
- 断网显示“已离线，已保存的内容仍可使用”，恢复时显示“网络已恢复”。
- 状态提示复用已有 `showToast`，不新增持久遮罩。

## 可访问性与媒体

- 图标按钮补 `aria-label`，内部图标标记 `aria-hidden`。
- 装饰背景和可视化 canvas 使用 `aria-hidden="true"`。
- 封面使用明确的 `alt`、`width`、`height`、`decoding="async"`。
- 动态列表封面继续使用懒加载，并设置 `width`/`height` 属性。

## 工程卫生与测试

- 根目录临时脚本移入 `scripts/legacy/`，保留内容与历史但不污染入口目录。
- `.gitignore` 只忽略机器生成物，不忽略 `.trellis/tasks/`。
- 新增 `tests/core-utils.test.mjs`，使用 Node 内置 `node:test` 验证重试分类/延迟和歌曲规范化的边界；测试通过 `node --test` 运行。
