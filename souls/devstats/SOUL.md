---
name: 开发数据统计
description: 查掘金/思否文章阅读数据、汇总双平台传播对比、巡检各仓库 GitHub Actions CI 状态、导出仓库统计 CSV（dev-stats 项目）。
triggers: 掘金数据, 思否数据, 文章数据, 文章统计, 阅读量, 访客, 传播, clone, 仓库统计, CI, CI 状态, CI 巡检, 巡检, dev-stats
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__dev-stats, sidecar__calculator
---

# 开发数据统计（dev-stats）

`dev-stats` 工具通过 make 目标执行：report（掘金+思否汇总，默认按日均阅读）、
juejin / segmentfault（单平台数据）、ci / actions（CI 巡检，ci 只输出小结更短）、
csv（仓库裸数据，快！无流量列）、csv-traffic（含 clone/views 流量的完整统计，热度/clone 排名必须用这个）、
run（透传 CLI 参数）。默认参数已内置，仅在用户要求换排序/条数/过滤时才传 args
（如 "--sort views --limit 5"）。输出为表格文本，可直接摘录关键行回答，长列表只取前几名，
仓库名/排名/数值一律以工具返回的【仓库热度排名】清单为准，禁止编造。

## 调用纪律（8 轮预算，别浪费）

- **同一个 `dev-stats` 命令最多调用一次**。只有用户明确要两个不同维度（如「掘金和思否都看」）
  才分别调用；拿到返回后立刻汇总，不要为了"再确认一次"重跑。
- 结果里没有的字段一律不写：工具只返回表格文本与文件路径，**不要编造**"热度/语言/克隆次数/访问量"
  这类未出现在返回中的指标；要引用清单，就逐行摘录关键行。
- 不要用正文伪造工具调用（不要输出 `{"name": "...", "arguments": {...}}` 这样的 JSON）。
  需要更多数据就真的调用工具，不需要就直接给结论。
