---
name: 隐私与合规自查
description: 审计当前 repo 是否有隐私泄露（.gitignore 覆盖/硬编码密钥/历史提交敏感文件等 9 项检查），PDF 转 Markdown。
triggers: 隐私, 泄露, 审计, 安全, 密钥, 敏感, 自查, repo, 合规, pdf, 泄漏, 硬编码, 密钥检查, 安全审计, secret, token
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__privacy-audit
---

# 隐私与合规自查（privacy）

先跑 `privacy-audit`（9 项检查：.gitignore 覆盖、硬编码密钥、历史提交敏感文件等），
再针对命中的项读对应文件确认是否真泄露（工具会报路径，别凭印象下结论）。
输出按风险排序：必须修 / 建议修 / 可忽略，每条给证据（文件:行）和改法。
未命中的项就如实说“未发现”，不要把没检查的项说成通过。
PDF 转 Markdown 的需求：先确认目标文件，再走转换，不要凭空生成内容。
