---
name: hot-news-post
description: 基于热点新闻生成合规的小红书/抖音营销文案。先抓新闻建 RAG grounding，再调 llamaindex-pse hot-news 流水线（Planner+Specialist+Evaluator+确定性合规 verify_fn）产出图文，内置违禁词/平台格式/AI标注/事实对照核查。适合「帮我写个小红书热点文案」「就 XX 热点发条抖音」。
triggers: 热点, 热搜, 新闻, 微博, 话题, 小红书, 抖音, 营销文案, 热点文章, 蹭热点, 爆款, 种草, 文案, 头条
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__hot-news-fetch, sidecar__hot-news-topics, sidecar__hot-news, sidecar__hot-news-check, sidecar__hot-news-publish
---

# 热点营销文案（Hot News Post）

## 适用场景

用户想基于某个热点话题，生成一篇可用于小红书 / 抖音等平台的营销文案（图文 / 口播稿）。
文案由 llamaindex-pse 的 hot-news 流水线生成：先抓新闻建 RAG 索引做事实 grounding，再跑
Planner/Specialist/Evaluator 三角色 + 每轮确定性合规核查，产出带「AI 辅助创作」标注的 Markdown。

## 调用纪律（硬约束）

- `hot-news` **最多调用一次**：流水线自带新闻抓取/索引/三角色生成/合规核查，重跑只会再花 1-3 分钟并产生重复稿件。
- 工具返回成稿后**立即整理输出**（标题 + 正文 + 保存路径），不要再去 `hot-news-check` / `hot-news-publish` 或重跑一次来"确认"。
- 永远不要用正文文字模拟工具调用（例如写出 `tool sidecar__hot-news({...})` 这样的文本）；要调工具就走真正的函数调用，参数必须是 JSON 对象。
- 工具返回 `error:` 时原样转述，不要编造文案；单次运行总调用 ≤3 次。
- **调用前不要先写正文草稿**（免费网关模型单分钟 token 上限只有 8k：先写一版长草稿 + 工具返回的成稿会让下一轮请求直接 413）。直接调工具，拿到成稿后**原样输出**，不要重写或复述第二遍。
- 输出以「标题 + 正文 + 保存路径」为限，不要附加工具日志；路径必须**逐字复制**工具返回的那一行（含 `frameworks/llamaindex-pse` 拼写），不要手打。

## 步骤

**执行原则：在调用 `hot-news` 工具并拿到成稿（或确定失败、需要用户选择）之前，不要结束本轮回复。**
每一步都通过调用对应工具推进，不要只输出声明性文本就收尾。

0. **（可选前置）抓取新闻**：需要真实新闻做 RAG grounding 时，**优先调用 `hot-news-fetch`**
   工具（流水线内置的多平台抓取，自动落盘到快照目录，`hot-news` 会自动用作 grounding 源）。
   仅当用户明确提供了特定新闻链接、需要补充抓取时，才考虑用 `browser-open` /
   `browser-screenshot`（resolve-studio 内置，只读无审批）打开该链接并把正文落盘为
   一个目录（如 `/tmp/news-<topic>/`），每个新闻一个 `.md`，再通过 `news_dir` 传给 `hot-news`。
   若跳过此步，流水线降级为纯主题生成，丢失事实对照能力。

1. **生成合规文案**：调用 `hot-news` 工具。
   - `topic`：热点主题（必填）。
   - `news_dir`：上一步的新闻目录（强烈建议）。
   - `platform`：`xiaohongshu`（默认）/ `douyin` / `zhihu` / `toutiao`。
   - `category`：品类，决定违禁词表松紧。`tech_ai`（默认，最宽松，适合技术个人 IP）/ `beauty` / `food` /
     `education` / `finance` / `medical` / `ecommerce`。金融/医疗为高危品类，词表从严。
   - `provider`：默认 `agnes`（免费，无需审批）。`deepseek` / `scnet-kimi` / `scnet-minimax`
     为付费网关，显式指定需人工审批——后台任务应保持默认 `agnes`，不要主动传付费 provider。
   - 流水线耗时 1-4 分钟。产物经工具读取回传完整 Markdown（文件落
     `<HARNESS_PSE_DIR>/tasks/hot-news/articles/hot_news_<platform>_<provider>.md`，
     无需自行拼接路径）。
   - 若返回 `error:` 开头：原样转述错误，不要编造文案内容。

2. **呈现文案**：工具会回传完整 Markdown。向用户展示时说明：
   - 本次平台 / 品类 / 模型；
   - 是否提供了 news_dir（决定有无事实对照）；
   - 合规核查已由流水线内置（违禁词 / 标题≤20字 / AI 标注 / 事实对照），但**仍建议人工过目**。

## 注意事项

- **合规是第一公民**。2026 年小红书/抖音启用品牌违规营销分与 AI 生成内容强制标注：
  - 产物必须含「AI 辅助创作」标记（流水线已自动注入，verify_fn 硬查）；
  - 批量洗稿 / 低质累计 3 条直接封号；AI 生成未标注即违规；
  - 极限词（最/第一/绝对/百分百）、导流词（微信/加我/私信领）、虚假诱导（秒杀/倒计时/错过再无）一律命中即违规。
- **发布端独立于本技能**：本技能只产出 Markdown。小红书发布**禁用浏览器自动化**——
  平台已对「疑似使用三方工具或脚本自动运营账号」发出警告，必须**人工复制粘贴**发布，
  并手动勾选「AI 辅助创作」以匹配产物标记。抖音/知乎/头条同属 2026 新规高危品类、关联账号连带，
  建议同样「生成 → 人工确认 → 手动发」，规避封号风险。
- **隐私/真实性**：文案事实须能在 news_dir 新闻中核实；纯 topic 降级生成无事实对照，仅适合练手。
- 若工具返回 `error:` 前缀：说明流水线失败（多为缺依赖 / 无 API key），原样转述，不要编造。
