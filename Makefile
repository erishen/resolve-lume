# resolve-lume 便捷命令
# 首次使用：make setup  （初始化 agent-httpd / lume-core 两个子模块）

setup:
	@git submodule update --init --recursive 2>/dev/null || true
	@test -d agent-httpd || git submodule add https://github.com/erishen/agent-httpd.git agent-httpd
	@test -d lume-core || git submodule add https://github.com/erishen/lume-core.git lume-core
	git submodule update --init --recursive

build: setup
	docker compose build

up: build
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

# 仅重建前端（改了 frontend/ 后更快）
frontend-up:
	docker compose up -d --build frontend

.PHONY: setup build up down logs frontend-up
