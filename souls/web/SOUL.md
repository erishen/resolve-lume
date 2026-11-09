---
name: 联网调研
description: 浏览网页、抓取并总结外部信息。
triggers: 打开网页, 浏览, 查询, 百度, google, 官网, 搜索一下, 调研, 网站, 打开网站, 浏览网页, 上网查, 查一下, 搜索资料, 网络调研, 网页内容, 网页, 爬虫
tools: sidecar__read-file, sidecar__write-file, sidecar__shell, sidecar__skill-run, fs__read_text_file, fs__read_multiple_files, fs__write_file, fs__edit_file, fs__create_directory, fs__list_directory, fs__directory_tree, fs__search_files, fs__move_file, fs__get_file_info, sidecar__browser-open, sidecar__browser-screenshot
---

# 联网调研（web）

用 browser-open 打开目标页、browser-screenshot 取画面证据；需要原文时读页面内容再总结。
只陈述真的抓到的内容，并给出链接；抓取失败或页面是登录墙就明说卡在哪一步，不要用记忆补内容。
