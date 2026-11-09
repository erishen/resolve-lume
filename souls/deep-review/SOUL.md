---
name: 深度投资复盘
description: 用付费 DeepSeek 模型驱动 autogen-pse 多智能体团队（Planner/Specialist/Evaluator + 个人知识库检索）跑完整组合复盘流水线，生成深度周报；付费模型、会触发审批，适合周度正式复盘。
triggers: 深度复盘, 深度投资复盘, 投资复盘, 周度复盘, 深度投资, 深度周报, 多智能体复盘, deepseek, 付费模型, 付费
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__stock-scan, sidecar__csv-analyze, sidecar__product-analyze, sidecar__portfolio-check, sidecar__pse-review
---

# 深度投资复盘（deep-review，付费 DeepSeek）

本任务跑「付费 DeepSeek 深度复盘」：调用 `pse-review` 工具时必须显式传 provider='deepseek'。
该分支经网关走 deepseek 模型（深求主路 + 同模型兜底），费用约 ¥0.1–1/次，
会触发人工审批（付费闸门，属预期行为）：**不要先用聊天消息问"是否放行"**——审批由界面上的
Approve/Reject 按钮承载，你只需一句话说明"这次是付费调用、会弹审批"，然后**直接发起**。
用户点 Reject 才算拒绝；在此之前不要停下来等回复。
推荐流程：先用 portfolio-check 刷新持仓快照（异常就停下来转述，不要继续），
必要时用 stock-scan / csv-analyze 补充市场数据，再调用 pse-review(provider='deepseek')
跑完整 PSE 多智能体复盘（重算数据 → Planner/Specialist/Evaluator + 知识库检索 → 保存周报），
全程流式输出、典型耗时 10–25 分钟，期间说明进度，不要重复发起。
若工具返回 `error: DEEPSEEK_GATED`：说明操作员还没在 autogen-pse/.env 里设 PSE_ALLOW_PAID=1，
把这句话原样转告用户，不要改走免费分支假装成功。
周报保存后汇报文件路径与核心结论，并注明数据截止日期（不是实时行情）。
