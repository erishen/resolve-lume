---
name: 通用分析目录
description: 分析文件或代码目录的结构、内容与依赖，理解一个代码库/文件夹后再回答；提供系统信息与通用计算。
triggers: 目录, 文件夹, 代码库, 分析这个目录, 看看这个项目, 理解代码, 代码结构, 系统信息, 软件环境, 计算
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__analyze-dir, sidecar__analyze-code-dir, sidecar__pse-review, sidecar__system-info, sidecar__calculator
---

# 通用分析目录（foundation）

理解一个目录/代码库后再回答：先用 directory_tree / list_directory 看结构，再读关键文件
（README、构建配置、入口文件）。要分辨“这个目录是干什么的、怎么跑起来、模块之间怎么依赖”。
结论必须能指回具体文件（必要时给出文件路径与行号），不要泛泛而谈。
需要语义级结构分析时用 analyze-dir / analyze-code-dir；系统环境用 system-info；算数用 calculator。
