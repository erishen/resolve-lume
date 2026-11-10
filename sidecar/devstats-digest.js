/**
 * devstats-digest.js — 把 dev-stats 的 stats.csv 压成「权威清单」
 *
 * 起因：csv-traffic 目标会返回 6 万字符的完整表格，对话模型在里面摘数时
 * 把仓库名编了出来（数字对、名字全是拼凑的）。这里改成先给一份短清单：
 * 名字逐字来自 CSV，模型只允许引用清单里的名字。
 */

const NAME_MAX = 12

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function table(title, rows, metric, extra) {
  const lines = [`【${title}】`]
  rows.slice(0, NAME_MAX).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name}：${metric(r)}${extra ? '，' + extra(r) : ''}`)
  })
  return lines
}

/**
 * @param {Array<Record<string,string|number>>} rows 已解析的 stats.csv 行
 * @param {{topN?: number, total?: number}} [opts]
 * @returns {string} 供工具直接返回的摘要（空数据时返回空串）
 */
function buildTrafficDigest(rows, opts = {}) {
  const topN = Math.max(1, Number(opts.topN) || 10)
  if (!Array.isArray(rows) || rows.length === 0) return ''

  const byCloners = rows
    .filter((r) => num(r.cloners_14d) > 0)
    .sort((a, b) => num(b.cloners_14d) - num(a.cloners_14d))
    .slice(0, topN)
  const byViews = rows
    .filter((r) => num(r.views_total_14d) > 0)
    .sort((a, b) => num(b.views_total_14d) - num(a.views_total_14d))
    .slice(0, topN)

  const out = []
  out.push(`【仓库热度（近 14 天，来源 output/stats.csv，共 ${opts.total ?? rows.length} 个仓库有数据）】`)
  out.push('仓库名一律逐字引用下面两份清单；清单里没有的名字就是本次统计里没有的，不要编造、拼凑或补全。')
  out.push('')
  out.push(...table('按独立 clone 人数排序', byCloners, (r) => `${num(r.cloners_14d)} 人`, (r) => `clone 总 ${num(r.clones_total_14d)} 次 / views ${num(r.views_total_14d)}`))
  out.push('')
  out.push(...table('按阅读量排序', byViews, (r) => `${num(r.views_total_14d)} 次`, (r) => `独立阅读 ${num(r.viewers_14d)} 人 / 独立 clone ${num(r.cloners_14d)} 人`))
  return out.join('\n')
}

/** dev-stats 账号画像行（关注者/关注/公开仓库/注册年）——属个人信息，返回给模型前整行丢弃。 */
const ACCOUNT_PROFILE_RE = /^\s*账号[:：].*(关注者|公开仓库)/

/**
 * 返回给模型前的脱敏：家目录缩短成 ~，账号画像行丢弃，其余原样。
 * @param {string} text
 * @param {string} [home] 家目录绝对路径（一般传 os.homedir()）
 * @returns {string}
 */
function sanitizeToolText(text, home) {
  const s = String(text == null ? '' : text)
  const out = home ? s.split(home).join('~') : s
  return out
    .split('\n')
    .filter((line) => !ACCOUNT_PROFILE_RE.test(line))
    .join('\n')
}

module.exports = { buildTrafficDigest, sanitizeToolText }
