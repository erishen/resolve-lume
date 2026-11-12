---
name: investment-tools
description: 直接调用 stock-scan / csv-analyze / product-analyze 三个独立工具，做全市场技术信号扫描、CSV 数据剖析、产品与竞品研究；不跑组合周报流水线。
---

# 投资分析工具箱（investment-tools）

这个任务只负责**三个独立的轻量分析工具**：`stock-scan`（技术信号扫描）、`csv-analyze`（CSV 剖析）、`product-analyze`（产品/竞品研究）。

它和「每周投资回顾」「深度投资复盘」是两回事：**不要**为了回答这里的问题去跑 `portfolio-check` → `pse-review` 的组合周报流水线（那是分钟级、涉及真实持仓、可能触发付费模型的重任务）。

## 工具契约

- 用户点名哪个工具就只调用哪个工具，**一次一个**，不要顺带调用另外两个，也不要改用 `read-file` / `shell` 自己拼数据。
- 这三个工具都不需要用户先选项目或选文章；参数按工具 schema 传。用户没给 CSV 文件路径时，`csv-analyze` 不传 `file`，让它用内置样例数据演示。
- 工具返回后直接把关键结论（信号/趋势/异常/竞品对比）用中文总结给用户，然后结束；不要复述工具调用行，也不要再发起别的工具调用。
- 工具返回 `error:` 时如实转述，不要编造数据，也不要换一个无关业务域的工具补救。

## 边界

- 用户明确说「投资周报 / 持仓复盘 / 组合体检」时属于 `weekly-investment` 或 `deep-review` 任务，不在本任务范围内。
- 本任务只挂了上述三个工具加 `capabilities`；找不到工具时调用 `capabilities` 查询并如实告知，不要凭印象拼造工具名。
