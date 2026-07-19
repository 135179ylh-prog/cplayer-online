# Research - 播放质量核对

## 已核实

- `MusicService` 默认使用 `localStorage.getItem('cp_quality') || 'jymaster'`，并把该值传给 `/163_music?level=`。
- 只要响应有 `d.url` 就交给原生 `<audio>` 播放，未验证返回 level、MIME 或最低码率。
- 请求开始时桌面质量徽标硬编码为 `JyMaster`；实际 UI 只在能从 URL/码率分类时才替换它。
- 原分类把 320 kbps 标成 Hi-Res，且 URL/高码率推断会标成 JyMaster，均超出了可证明信息。
- 移动端最终复制桌面徽标的 `innerHTML` 和 class，未同步完整的可访问性说明。

## 决策

保留“优先请求 jymaster”作为请求偏好，但不把它显示为实际保证。仅信任 API 明确返回的等级；URL/码率只作保守分类，未知状态明确提示。

## 实现约束

- `getSong` 只返回显式字符串 `d.level`；不能再用请求参数回填 level。
- 只有活跃播放请求在 token 校验后渲染质量。预加载和搜索可调用 `getSong`，但不会改质量徽标。
- `renderPlaybackQuality` 同时更新桌面和移动节点的文本、class、`title`、`aria-label`；移动 UI 不再延迟复制 desktop 的 HTML。
- 码率必须明确以 bps 表示才参与推断。数值 `320` 没有单位，不当作 320 kbps；只有 URL pathname 以 `.flac` 结尾才推断无损。
- API 标注的可见文本增加“标注”前缀，例如“标注 JyMaster”，使来源不只存在于 tooltip 中；浏览器无法验证音频比特流，因而不承诺绝对音质。
