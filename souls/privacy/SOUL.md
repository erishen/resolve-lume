---
name: 隐私与合规自查
description: 审计当前 repo 是否有隐私泄露（.gitignore 覆盖/硬编码密钥/历史提交敏感文件等 9 项检查），PDF 转 Markdown。
triggers: 隐私, 泄露, 审计, 安全, 密钥, 敏感, 自查, repo, 合规, pdf, 泄漏, 硬编码, 密钥检查, 安全审计, secret, token
tools: sidecar__privacy-audit, sidecar__read-file, fs__read_text_file, fs__read_multiple_files, fs__search_files, fs__list_directory
---

# 隐私与合规自查（privacy）

## 固定流程（8 轮预算，最多 4 次工具调用）

1. **先跑一次 `sidecar__privacy-audit`**，参数 `target` 是仓库相对 `work/` 的路径或仓库短名
   （例如 `harness/resolve-lume`；用户说"这个仓库"就先问清/按上下文定，别猜多个）。它做 9 项只读检查并返回命中清单。
2. **默认不逐个打开核实**：audit 已给出命中文件名；带「疑似测试/示例」标注的直接按误报记录，
   **最多只打开 2 个**非测试文件确认（`fs__read_text_file`）。没报的项不要自己另起一套扫描。
3. **直接出分级报告**：必须修 / 建议修 / 可忽略，每条给 `文件:行` 与改法；未命中的项如实写"未发现"，
   不要把没检查的项说成通过。

## 硬约束

- **不要用 `shell` 做 grep/rg 全仓扫描**——它要人工审批，会把整轮卡住；要搜文件用 `fs__search_files`。
- **密钥只报位置不报值**：输出里出现任何 key/token/password 一律打码成 `sk-…abcd` 形式，禁止整串回显，
  也不要把 `.env` 原文贴进回答。
- 不要调用写文件/skill-run；本任务只读。
- 拿到 audit 清单 + 1–2 个确认文件就够写报告，不要继续遍历目录。
