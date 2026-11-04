#!/usr/bin/env node
// resolve-lume 宿主 sidecar 守护进程（launcher）。
//
// 角色定位：
//   sidecar（Node 网关 + 工具执行层）已从 docker 容器搬到宿主 macOS 常驻。本进程是它的
//   薄管理壳——在宿主上 fork/回收 sidecar 子进程，并对外提供 loopback HTTP 控制面。
//   理论调用链：UI 按钮 → frontend 容器 nginx 反代 /launcher/* → 本进程(:3099)
//   → spawn/kill sidecar(:3000)。目前前端尚未接 /launcher 反代，控制面主要经
//   `make sidecar-host-start|stop|status` 调用。
//
//   本进程自己由 make 目标 nohup 拉起（日志 .data-sidecar/launcher.log）；
//   【launcher 自身崩溃 = 需要 `make sidecar-host-stop` 后重新
//   `make sidecar-host-start`】，launchd 开机自启见 README 宿主模式小节。
//
// 相对已退役旧设计 legacy/host-sidecar/launcher.js 的关键改进：
//   1. sidecar 是【直接子进程】（非 detached / unref），launcher 监听其 'exit'：
//      崩溃且非用户主动停止 → 2s 退避后自动重拉（旧设计 detached 后无人看管，
//      sidecar 崩了就无声死掉）。
//   2. 重拉有上限：连续崩溃最多 5 次后放弃并记录日志（防止配置错误导致
//      疯狂重启打满 CPU）；sidecar 若稳定跑过 30s，重试预算重置。
//   3. env 不再由 launcher 全量透传给 sidecar——白名单 env 由子脚本
//      start-host.sh 自行显式 export；launcher 只负责进程生命周期。
//
// HTTP 接口（仅 127.0.0.1，无 CORS 头）：
//   GET  /health  -> "ok"
//   GET  /status  -> { running: bool, pid?: number }
//   POST /start   -> 未运行则拉起 sidecar，返回 { running, pid }
//   POST /stop    -> 主动停止 sidecar（置 stopping，不触发重拉），返回 { running:false }
//
// 不加 CORS 的理由（沿用旧设计）：浏览器只能经 nginx 同源 /launcher/ 反代到达本
// 控制面，加 wildcard CORS 等于把「能 fork/杀宿主进程」的控制台暴露给任意网页。

'use strict'

const http = require('http')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

// ---------- 路径常量 ----------
const LAUNCHER_DIR = __dirname
const ROOT = path.resolve(LAUNCHER_DIR, '..') // = resolve-lume 仓库根
const SIDECAR_SCRIPT = path.join(ROOT, 'sidecar', 'start-host.sh')
const DATA_DIR = path.join(ROOT, '.data-sidecar')
const SIDECAR_PIDFILE = path.join(DATA_DIR, 'sidecar.pid')
const LAUNCHER_PIDFILE = path.join(DATA_DIR, 'launcher.pid')
const SIDECAR_LOGFILE = path.join(DATA_DIR, 'sidecar.log')

// ---------- 可调参数 ----------
const LAUNCHER_PORT = parseInt(process.env.LAUNCHER_PORT || '3099', 10)
const LAUNCHER_HOST = process.env.LAUNCHER_HOST || '127.0.0.1'
// 崩溃重拉预算：连续崩溃超过此次数后放弃（侧记日志，等人工/ make 介入）。
const MAX_RETRIES = 5
const BACKOFF_MS = 2000
// sidecar 连续稳定运行超过该时长 → 认为本次启动是健康的，重试预算清零。
const HEALTHY_UPTIME_MS = 30_000
// 默认【不】自拉 sidecar：由 make sidecar-host-start 显式 POST /start。
// 仅当改造成 launchd 常驻时才设 LAUNCHER_AUTOSTART=1。
const AUTOSTART = process.env.LAUNCHER_AUTOSTART === '1'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.writeFileSync(LAUNCHER_PIDFILE, String(process.pid))

// ---------- 进程状态（launcher 内存中的唯一真相） ----------
let child = null // 当前 sidecar 子进程（bash→exec node），未运行时为 null
let stopping = false // 用户主动停止标志；set 后 sidecar 退出【不】重拉
let retries = 0 // 连续崩溃计数
let childStartedAt = 0 // 当前子进程启动时刻，用于健康度结算
let restartTimer = null // 退避重拉的 setTimeout 句柄

function log(...args) {
  const stamp = new Date().toISOString()
  console.log(`[launcher ${stamp}]`, ...args)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readSidecarPid() {
  try {
    const pid = parseInt(fs.readFileSync(SIDECAR_PIDFILE, 'utf8').trim(), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function status() {
  // 以 pidfile 为准（start-host.sh 在 exec 前写入，pid == 之后的 node pid）；
  // launcher 内存里的 child.pid 与之必然相等（同一进程树）。
  const pid = readSidecarPid()
  if (pid && isAlive(pid)) return { running: true, pid }
  // pidfile 残留但进程已死 → 清理，避免下次 status 误报 running。
  if (pid) {
    try {
      fs.unlinkSync(SIDECAR_PIDFILE)
    } catch {}
  }
  return { running: false }
}

// ---------- 拉起 sidecar ----------
function spawnChild() {
  if (child) return // 已有子进程在跑
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  stopping = false
  const logFd = fs.openSync(SIDECAR_LOGFILE, 'a')
  // 非 detached：子进程与 launcher 同进程组，launcher 直接监听 'exit'。
  // env 只透传给子脚本本身；具体业务 env 白名单由 start-host.sh 内部 export。
  child = spawn('bash', [SIDECAR_SCRIPT], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  childStartedAt = Date.now()
  log(`spawned sidecar: bash pid=${child.pid} (script=${SIDECAR_SCRIPT})`)

  child.on('error', (err) => {
    log('child error event:', err.message)
  })
  child.on('exit', (code, signal) => {
    const uptimeMs = Date.now() - childStartedAt
    child = null
    try {
      fs.unlinkSync(SIDECAR_PIDFILE)
    } catch {}
    if (stopping) {
      log(`sidecar exited on purpose (code=${code} signal=${signal}); no respawn`)
      return
    }
    // 崩溃路径：跑满 HEALTHY_UPTIME 才算健康，健康则重试预算清零。
    if (uptimeMs > HEALTHY_UPTIME_MS) retries = 0
    retries++
    if (retries > MAX_RETRIES) {
      log(`sidecar crashed (code=${code} signal=${signal}) after ${uptimeMs}ms; ` +
          `retries exhausted (${MAX_RETRIES}). NOT respawning. ` +
          `Investigate ${SIDECAR_LOGFILE}, then ` +
          `POST /start (or make sidecar-host-stop && make sidecar-host-start) to retry.`)
      return
    }
    log(`sidecar crashed (code=${code} signal=${signal}) after ${uptimeMs}ms; ` +
        `respawn #${retries}/${MAX_RETRIES} in ${BACKOFF_MS}ms`)
    restartTimer = setTimeout(spawnChild, BACKOFF_MS)
  })
}

// ---------- 停止 sidecar（主动停止，不触发重拉） ----------
async function stopChild() {
  stopping = true
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  const pid = readSidecarPid() || (child ? child.pid : null)
  if (pid && isAlive(pid)) {
    // 非 detached 子进程与 launcher 同进程组，child.pid 不是组 leader，
    // kill(-pid) 找不到对应进程组、ESRCH 静默忽略——真正生效的是单杀 child.pid。
    // 组杀调用保留只为与旧设计对称、将来若改 detached 也能直接工作。
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {}
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
    for (let i = 0; i < 30 && isAlive(pid); i++) await sleep(100)
    if (isAlive(pid)) {
      log(`pid ${pid} still alive after SIGTERM; escalating to SIGKILL`)
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {}
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
      await sleep(200)
    }
  }
  try {
    fs.unlinkSync(SIDECAR_PIDFILE)
  } catch {}
  child = null
  return { running: false }
}

// ---------- HTTP 控制面 ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0]
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method === 'GET' && url === '/status') {
    return sendJson(res, 200, status())
  }
  if (req.method === 'POST' && url === '/start') {
    return void (async () => {
      const cur = status()
      if (cur.running) return sendJson(res, 200, cur)
      spawnChild()
      // 等 pidfile 出现（start-host.sh 在 exec 前写），最多 ~3s
      for (let i = 0; i < 30; i++) {
        const st = status()
        if (st.running) return sendJson(res, 200, st)
        // bash 已 spawn 但 pidfile 尚未写出时，用 child.pid 兜底
        if (i >= 10 && child && isAlive(child.pid)) {
          return sendJson(res, 200, { running: true, pid: child.pid })
        }
        await sleep(100)
      }
      return sendJson(res, 200, status())
    })()
  }
  if (req.method === 'POST' && url === '/stop') {
    return void stopChild().then((st) => sendJson(res, 200, st))
  }
  sendJson(res, 404, { error: 'not found', path: url })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${LAUNCHER_PORT} already in use — another launcher is running? ` +
        `check ${LAUNCHER_PIDFILE}`)
  } else {
    log('server error:', err.message)
  }
  process.exit(1)
})

server.listen(LAUNCHER_PORT, LAUNCHER_HOST, () => {
  log(`listening on http://${LAUNCHER_HOST}:${LAUNCHER_PORT}`)
  log(`sidecar script : ${SIDECAR_SCRIPT}`)
  log(`pidfile        : ${SIDECAR_PIDFILE}`)
  log(`respawn budget : max ${MAX_RETRIES} consecutive crashes, backoff ${BACKOFF_MS}ms`)
  log(`autostart      : ${AUTOSTART}`)
  if (AUTOSTART) spawnChild()
})

// ---------- 自身退出处理 ----------
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('received shutdown signal; stopping sidecar and exiting')
  try {
    await stopChild()
  } finally {
    try {
      fs.unlinkSync(LAUNCHER_PIDFILE)
    } catch {}
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  try {
    fs.unlinkSync(LAUNCHER_PIDFILE)
  } catch {}
})
