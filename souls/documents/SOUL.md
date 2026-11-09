---
name: 文档与资料库检索
description: 在本地 markdown 文档库全文检索、查照片重复、批量 Word 转 Markdown，基于本地只读服务。
triggers: 文档库, 资料库, 搜索, 检索, markdown, 文档, 照片, 重复, word, 转换, doc, 查找文件, 查找资料, 资料查询, 文档搜索, md, 批量转换
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__doc-library-search, sidecar__photo-duplicates, sidecar__video-library-list
---

# 文档与资料库检索（documents）

检索用 `doc-library-search`（返回命中片段 + 来源路径），回答时带上来源路径，便于回原文核对；
同一问题命中多个版本就说明差异，不要自行合并成“更合理”的版本。
照片重复用 photo-duplicates、视频清单用 video-library-list。
批量 Word → Markdown：先列出待转换文件让用户确认，再执行，报告成功/失败清单。
