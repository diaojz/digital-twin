/**
 * quota.js — 区域 D：视频生成额度计量与配额
 *
 * 真人版每次生成对口型视频要按秒计费（EMO ≈ 0.16 元/秒），父母端高频陪聊若不设上限会失控，
 * 所以按「家庭 + 自然月」累计已用视频秒数，超过 env QUOTA_VIDEO_SECONDS（默认 300s/月）后
 * 走语音降级路径（voice_delivered），不再真实生成视频。
 *
 * 数据落在 family.db 的 quota_usage 表（建表 + seed 由区域 A family.js 负责，本模块只读写）：
 *   quota_usage(family_id, month, video_seconds, video_count, PRIMARY KEY(family_id, month))
 *   month 形如 '2026-06'。
 *
 * 依赖处理（契约 §7：A-D 模块零相互 import，共享只允许 import family.js 的 db 句柄导出）：
 *   本模块只 import family.js 暴露的 db 句柄取数，不碰 family.js 的业务函数。
 */

import { getDb } from './family.js';

// 月度视频额度上限（秒）。来自 env，缺省 300s/月。
// 注意：读 process.env 写成 getter，避免模块加载早于 dotenv 时锁死默认值。
function capSeconds() {
  return parseInt(process.env.QUOTA_VIDEO_SECONDS || '300', 10);
}

/** 当前自然月 key，形如 '2026-06'（本地时区） */
function currentMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 累计一次视频生成的用量（当月）
 * @param {number} familyId 家庭 id
 * @param {number} seconds  本次估算/实际秒数（估秒：文本长度/4 或视频实长）
 * @returns {{ month, videoSeconds, videoCount }} 累计后的当月用量
 *
 * 估秒约定见契约 §4：调用方按「文本长度/4」或视频真实时长传入。
 * 用 upsert：当月首次落账则插入，否则在原值上累加。
 */
export function addUsage(familyId, seconds) {
  const db = getDb();
  const month = currentMonth();
  // 防御：seconds 非法（NaN / 负数）按 0 处理，不污染累计值
  const sec = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;

  db.prepare(`
    INSERT INTO quota_usage (family_id, month, video_seconds, video_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(family_id, month) DO UPDATE SET
      video_seconds = video_seconds + excluded.video_seconds,
      video_count   = video_count   + 1
  `).run(familyId, month, sec);

  const row = db.prepare(
    'SELECT video_seconds, video_count FROM quota_usage WHERE family_id = ? AND month = ?'
  ).get(familyId, month);

  return {
    month,
    videoSeconds: row ? row.video_seconds : sec,
    videoCount: row ? row.video_count : 1,
  };
}

/**
 * 取当月用量快照（供 C5 成本面板 / GET /api/family 展示）
 * @param {number} familyId
 * @returns {{ month, videoSeconds, videoCount, capSeconds, exceeded }}
 *   videoSeconds —— 已用秒数（无记录则 0）
 *   capSeconds   —— 当月上限
 *   exceeded     —— 已用是否 >= 上限
 */
export function getUsage(familyId) {
  const db = getDb();
  const month = currentMonth();

  const row = db.prepare(
    'SELECT video_seconds, video_count FROM quota_usage WHERE family_id = ? AND month = ?'
  ).get(familyId, month);

  const videoSeconds = row ? row.video_seconds : 0;
  const videoCount = row ? row.video_count : 0;
  const cap = capSeconds();

  return {
    month,
    videoSeconds,
    videoCount,
    capSeconds: cap,
    exceeded: videoSeconds >= cap,
  };
}

/**
 * 生成前的额度闸门：判断本次是否还允许真实生成视频
 * @param {number} familyId
 * @returns {{ allowed, remainSeconds }}
 *   allowed       —— 是否放行（已用 < 上限）
 *   remainSeconds —— 剩余秒数（最小 0）
 *
 * 调用方约定（契约 §5）：不通过 → reply 走 voice_delivered 降级，speak 返回额度提示。
 */
export function checkQuota(familyId) {
  const { videoSeconds, capSeconds } = getUsage(familyId);
  const remainSeconds = Math.max(0, capSeconds - videoSeconds);
  return {
    allowed: videoSeconds < capSeconds,
    remainSeconds,
  };
}
