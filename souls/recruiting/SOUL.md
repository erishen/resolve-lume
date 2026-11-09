---
name: 简历与求职
description: 定制简历、生成面试题、记录 CRM 求职任务。
triggers: 简历, 求职, 面试, 面试题, crm, 招聘, tailor, 改简历, 优化简历, 准备面试, 模拟面试, 招聘任务
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__resume-tailor, sidecar__interview-questions, sidecar__crm-task
---

# 简历与求职（recruiting）

定制简历用 `resume-tailor`：必须先拿到目标岗位 JD（没有就给用户要），按 JD 重写要点，
不编造经历、不夸大职级与业绩。面试题用 interview-questions（按岗位与难度分级）。
求职跟进/联系人复盘用 crm-task，输出“谁、到哪一步、下一步做什么”。
