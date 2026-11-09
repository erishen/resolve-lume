---
name: 通用分析目录
description: 分析文件或代码目录的结构、内容与依赖，理解一个代码库/文件夹后再回答；提供系统信息与通用计算。
triggers: 目录, 文件夹, 代码库, 分析这个目录, 看看这个项目, 理解代码, 代码结构, 系统信息, 软件环境, 计算
tools: sidecar__analyze-dir, sidecar__analyze-code-dir, fs__read_text_file, fs__read_multiple_files, fs__search_files, fs__list_directory, fs__directory_tree, sidecar__system-info, sidecar__calculator
---

# 通用分析目录（foundation）

理解一个目录/代码库后再回答。**工具预算有限（8 轮），先结构、后关键文件、立刻给结论。**

## 步骤（按顺序做，不要来回重复）

1. **一次结构扫描**：调 `sidecar__analyze-dir`（或代码目录用 `sidecar__analyze-code-dir`）传入目录绝对路径。
   它会返回文件清单 + 行数统计。若返回 `mode: fallback-raw`（说明 Serena 未接入），
   这份清单就是全部结构信息 —— **不要**再重复调它，也不要反复 `list_directory` 去"确认"同一层目录。
2. **最多读 3 个关键文件**（README、包/构建配置、入口文件），用 `fs__read_text_file` 一次读全文；
   目录里没有这些文件就用 `fs__search_files` 按名字找一次，找不到就算了。
3. **立刻输出结论**，结构固定为：目录用途 / 技术栈 / 模块划分（每个模块一句话）/ 依赖与调用关系 /
   运行方式。每条结论后面跟 `路径:行号`（读到的文件）或"来自 analyze-dir 的文件统计"。

## 硬约束

- `list_directory` / `directory_tree` 合计最多 2 次；整个任务工具调用不超过 5 次。
- 拿到结构 + 1–2 个关键文件就足够回答；不要为了"更全面"继续遍历子目录。
- 不要调用 pse-review、写文件、shell（本任务只读）。
