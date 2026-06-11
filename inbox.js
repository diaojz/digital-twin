/**
 * inbox.js — M1 两端版「收件箱」区域 B（契约 §2）
 *
 * 职责：收件箱消息的增删查改 + 状态机管理。
 *   - 承载 F4「求助转真人」闭环：父母求助 → AI 先代答 → 子女语音回信 → 对口型视频送达
 *   - 也承载 alert（健康告警）/ leave_word（父母留言）两类轻量消息
 *
 * 数据层依赖：本模块不自己建库，import family.js 的 db 句柄导出 getDb()。
 *   - 表 inbox_message 由 family.js（区域 A）建（契约 §1 DDL）
 *   - A-D 模块零相互 import，唯一例外即此处共享 db 句柄（契约 §7 通用纪律）
 *
 * 状态机（契约 §0 + PRD 收件箱状态图）：
 *   pending（待回复）
 *     ├─ generating（生成中，仅 help 走此分支）
 *     │     ├─ delivered（视频送达）
 *     │     └─ voice_delivered（语音送达，视频失败降级）
 *     ├─ voice_delivered（额度不足 / 直接降级）
 *     └─ viewed（alert/leave_word 无生成分支，父母看完直接已查看）
 *   delivered → viewed
 *   voice_delivered → viewed
 *   非法迁移一律 throw（错误消息含当前态/目标态）。
 */

import { getDb } from './family.js';

// ── 状态机：合法迁移表 ────────────────────────────────────────
// key=当前态，value=允许迁移到的目标态集合（契约 §0 + PRD 状态图）
const LEGAL_TRANSITIONS = {
  pending: new Set(['generating', 'delivered', 'voice_delivered', 'viewed']),
  generating: new Set(['delivered', 'voice_delivered']),
  delivered: new Set(['viewed']),
  voice_delivered: new Set(['viewed']),
  viewed: new Set(), // 终态
};

// parent 视角「回信类」可见状态（契约 §2：本家庭 status in 这些态的回信消息）
const PARENT_VISIBLE_STATUS = new Set(['delivered', 'voice_delivered', 'viewed']);

// pending 提醒阈值：4 小时（契约 §2 scanReminders 用 created_at 判 4h）
const REMIND_THRESHOLD_MS = 4 * 60 * 60 * 1000;

// ── 工具 ─────────────────────────────────────────────────────

const now = () => Date.now();

/**
 * 校验状态迁移是否合法，非法直接 throw（错误消息含当前态/目标态）。
 */
function assertTransition(fromStatus, toStatus) {
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  if (!allowed) {
    throw new Error(`[inbox] 非法状态迁移：未知的当前态 "${fromStatus}" → "${toStatus}"`);
  }
  if (!allowed.has(toStatus)) {
    throw new Error(
      `[inbox] 非法状态迁移：不允许从 "${fromStatus}" 迁移到 "${toStatus}"`
    );
  }
}

/**
 * 把 DB 原始行规整为驼峰对象（前端/上游统一用驼峰）。
 */
function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    familyId: row.family_id,
    fromMember: row.from_member,
    type: row.type,
    status: row.status,
    originalText: row.original_text,
    aiReply: row.ai_reply,
    childReplyAudio: row.child_reply_audio,
    replyVideo: row.reply_video,
    replyText: row.reply_text,
    reminded: row.reminded,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    viewedAt: row.viewed_at,
  };
}

// ── 导出 API（契约 §2）────────────────────────────────────────

/**
 * 新建收件箱消息。
 * @param {{familyId:number, fromMember:number, type:string, originalText?:string, aiReply?:string}} p
 * @returns {object} message（驼峰）
 */
export function createMessage({ familyId, fromMember, type, originalText, aiReply }) {
  const db = getDb();
  const ts = now();
  const stmt = db.prepare(`
    INSERT INTO inbox_message
      (family_id, from_member, type, status, original_text, ai_reply, reminded, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, 0, ?, ?)
  `);
  const info = stmt.run(
    familyId,
    fromMember,
    type,
    originalText ?? null,
    aiReply ?? null,
    ts,
    ts
  );
  return getMessage(Number(info.lastInsertRowid));
}

/**
 * 列出消息。
 *   - child 视角（forRole==='child'）：本家庭全量，倒序（最新在前）
 *   - parent 视角（forRole==='parent'）：仅本家庭「回信类」消息
 *       = status in (delivered, voice_delivered, viewed) 的消息（父母只见有回信的）
 *
 * 关于契约 §2「parent 视角仅本人相关回信」的实现说明（单家庭单 parent 假设）：
 *   MVP 阶段 status 过滤 ≈ 本人相关——父母只会看到子女对其求助的回信，结果等价。
 *   parent 自己的 leave_word（status 恒为 pending）永不出现在此列表里，这是预期
 *   （父母端只看回信流，不在收件箱看到自己留言）。
 *   进入多成员/多 parent 阶段时，需改为按 `from_member = ?` 联合 status 过滤，
 *   否则一个 parent 会看到另一个 parent 求助的回信。
 * @param {number} familyId
 * @param {{forRole:string}} opts
 * @returns {object[]}
 */
export function listMessages(familyId, { forRole } = {}) {
  const db = getDb();
  let rows;
  if (forRole === 'parent') {
    // parent 只看本家庭已有回信进展的消息（delivered/voice_delivered/viewed）
    const placeholders = [...PARENT_VISIBLE_STATUS].map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT * FROM inbox_message
         WHERE family_id = ? AND status IN (${placeholders})
         ORDER BY created_at DESC, id DESC`
      )
      .all(familyId, ...PARENT_VISIBLE_STATUS);
  } else {
    // child 视角：本家庭全量倒序
    rows = db
      .prepare(
        `SELECT * FROM inbox_message
         WHERE family_id = ?
         ORDER BY created_at DESC, id DESC`
      )
      .all(familyId);
  }
  return rows.map(rowToMessage);
}

/**
 * 按 id 取单条消息。
 * @param {number} id
 * @returns {object|null}
 */
export function getMessage(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inbox_message WHERE id = ?').get(id);
  return rowToMessage(row);
}

/**
 * 推进状态机。非法迁移 throw（错误含当前态/目标态）。
 * @param {number} id
 * @param {string} status 目标态
 * @param {{childReplyAudio?:string, replyVideo?:string, replyText?:string}} extra
 * @returns {object} 更新后的 message
 */
export function setStatus(id, status, extra = {}) {
  const db = getDb();
  const current = getMessage(id);
  if (!current) {
    throw new Error(`[inbox] setStatus 失败：消息 id=${id} 不存在`);
  }
  assertTransition(current.status, status);

  const { childReplyAudio, replyVideo, replyText } = extra;
  // 仅在 extra 提供对应字段时更新，未提供保持原值
  db.prepare(
    `UPDATE inbox_message
     SET status = ?,
         child_reply_audio = COALESCE(?, child_reply_audio),
         reply_video       = COALESCE(?, reply_video),
         reply_text        = COALESCE(?, reply_text),
         updated_at = ?
     WHERE id = ?`
  ).run(
    status,
    childReplyAudio ?? null,
    replyVideo ?? null,
    replyText ?? null,
    now(),
    id
  );
  return getMessage(id);
}

/**
 * 标记已查看（父母播放回信），记录 viewed_at（闭环时长指标数据源）。
 * 走状态机：当前态 → viewed（非法 throw）。
 * @param {number} id
 * @returns {object} 更新后的 message
 */
export function markViewed(id) {
  const db = getDb();
  const current = getMessage(id);
  if (!current) {
    throw new Error(`[inbox] markViewed 失败：消息 id=${id} 不存在`);
  }
  // 已查看的幂等：再次调用不报错，直接返回
  if (current.status === 'viewed') return current;

  assertTransition(current.status, 'viewed');
  const ts = now();
  db.prepare(
    `UPDATE inbox_message
     SET status = 'viewed', viewed_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(ts, ts, id);
  return getMessage(id);
}

/**
 * 父母轮询：本家庭「已送达但父母尚未查看」的回信。
 *   status in (delivered, voice_delivered) 且 viewed_at 为空。
 * @param {number} familyId
 * @returns {object[]} 倒序
 */
export function pendingReplies(familyId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM inbox_message
       WHERE family_id = ?
         AND status IN ('delivered', 'voice_delivered')
         AND viewed_at IS NULL
       ORDER BY created_at DESC, id DESC`
    )
    .all(familyId);
  return rows.map(rowToMessage);
}

/**
 * 子女端角标未读数：pending（待子女回复）+ 未读 alert（健康告警）。
 *   未读 alert = type='alert' 且尚未 viewed。
 * @param {number} familyId
 * @returns {number}
 */
export function unreadCount(familyId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inbox_message
       WHERE family_id = ?
         AND (
           status = 'pending'
           OR (type = 'alert' AND status != 'viewed')
         )`
    )
    .get(familyId);
  return row ? row.n : 0;
}

/**
 * 扫描超时未回的求助：type='help' 且 pending 超 4h（按 created_at）且 reminded=0。
 *   命中者置 reminded=1，返回命中列表（server 定时器每 10min 调一次）。
 *
 * 注意 type='help' 过滤是必须的（契约 §2 + 本文件 §0 语义）：
 *   该定时器面向「求助（help）超时未回」的提醒。leave_word（父母留言，
 *   server.js createMessage type:'leave_word'）同样以 status='pending' 落库，
 *   且子女端无动作把它推离 pending——若不按 type 过滤，任何超 4h 未处理的
 *   留言都会被误判为「超时未回的求助」而触发提醒。alert 停留 pending 同理排除。
 * @returns {object[]} 被标记提醒的消息列表
 */
export function scanReminders() {
  const db = getDb();
  const cutoff = now() - REMIND_THRESHOLD_MS;
  // 先选出命中者，再批量标记（先查后写，便于返回列表）
  // 仅 type='help'：留言/告警不应触发「求助超时未回」提醒
  const rows = db
    .prepare(
      `SELECT * FROM inbox_message
       WHERE type = 'help'
         AND status = 'pending'
         AND reminded = 0
         AND created_at <= ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(cutoff);

  if (rows.length > 0) {
    const ts = now();
    const mark = db.prepare(
      `UPDATE inbox_message SET reminded = 1, updated_at = ? WHERE id = ?`
    );
    for (const r of rows) mark.run(ts, r.id);
  }
  // 返回标记后的最新状态
  return rows.map((r) => getMessage(r.id));
}
