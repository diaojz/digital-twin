/**
 * family.js — M1 两端 MVP · 区域 A（数据层 + 双口令/角色中间件）
 *
 * 职责（见 docs/M1-CONTRACT.md §1、§5）：
 *   - 在 data/family.db 一次性建好 4 张表：family / member / inbox_message / quota_usage
 *     （inbox.js / quota.js 只读写这些表，不重复建表；它们共享本文件导出的 db 句柄）
 *   - 幂等 seed：family(id=1) + child member + parent member
 *   - 提供家庭 / 成员的读写函数
 *   - authMiddleware()：替换现有 ACCESS_CODE 中间件的双口令 / 角色解析中间件
 *
 * 工程风格：ESM、Node 原生能力、node:sqlite（建库写法参照 memory.js）、中文注释。
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 配置 ─────────────────────────────────────────────────────
// 数据库文件：默认 data/family.db（可用 FAMILY_DB 覆盖，方便测试）
// FAMILY_DB 支持绝对路径（如 /tmp/x.db 落到 /tmp）与相对路径（相对项目根 __dirname）。
// 注意：path.join 遇到绝对路径段不会重置，故绝对路径必须 isAbsolute 守卫直接用，否则会被并到项目内。
const FAMILY_DB_ENV = process.env.FAMILY_DB || 'data/family.db';
const FAMILY_DB_PATH = isAbsolute(FAMILY_DB_ENV) ? FAMILY_DB_ENV : join(__dirname, FAMILY_DB_ENV);

// 邀请码来源 env（契约 §1）：
//   CHILD_CODE 缺省回落 ACCESS_CODE，再缺省 'dev-child'
//   PARENT_CODE 缺省 'dev-parent'（仅裸跑模式）
// 注意：这两个值仅作「首次 seed」的默认值；库里一旦有值，库优先（见 regenInviteCode）。
function envChildCode() {
  return process.env.CHILD_CODE || process.env.ACCESS_CODE || 'dev-child';
}
function envParentCode() {
  if (process.env.PARENT_CODE) return process.env.PARENT_CODE;
  // ⚠️ 安全：口令模式下（如线上只配了 ACCESS_CODE）父母口令绝不能落到可猜的
  // 'dev-parent' 默认值——否则任何人带 ?code=dev-parent 就能进父母端烧生成额度。
  // 此时随机生成并打印到启动日志，管理员可在子女端「家庭」页查看或换口令。
  if (process.env.CHILD_CODE || process.env.ACCESS_CODE) {
    const rand = 'p-' + Math.random().toString(36).slice(2, 10);
    console.warn(`[Family] 口令模式但未设 PARENT_CODE，已随机生成父母口令：${rand}（建议在 .env 显式设置 PARENT_CODE）`);
    return rand;
  }
  return 'dev-parent';
}

// 是否「全部 code 未配置」（本地裸跑模式判定，契约 §5.1）
// 只要 CHILD_CODE / PARENT_CODE / ACCESS_CODE 任一被显式配置，就进入口令模式。
function noCodeConfigured() {
  return !process.env.CHILD_CODE && !process.env.PARENT_CODE && !process.env.ACCESS_CODE;
}

// ── 初始化 SQLite（建库写法参照 memory.js）──────────────────────
// db 句柄导出供 inbox.js / quota.js 共享（契约 §7：A-D 模块零相互 import，
// 共享只允许 import family.js 的 db 句柄导出）。
export let db = null;

/**
 * db 句柄访问器：未初始化时自动 initFamilyDb()，保证拿到的是建好表的真实库。
 * inbox.js / quota.js 共享数据库统一走这个入口。
 */
export function getDb() {
  if (!db) initFamilyDb();
  return db;
}

/**
 * 建表 + seed，幂等。多次调用安全。
 */
export function initFamilyDb() {
  if (db) return db; // 已初始化，直接复用同一句柄

  // 确保 data 目录存在
  const dir = dirname(FAMILY_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new DatabaseSync(FAMILY_DB_PATH);

  // 4 张表一步到位（契约 §1）
  db.exec(`
    CREATE TABLE IF NOT EXISTS family (
      id INTEGER PRIMARY KEY,
      name TEXT,
      confirmed INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS member (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      role TEXT,
      nickname TEXT,
      invite_code TEXT UNIQUE,
      last_active INTEGER,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS inbox_message (
      id INTEGER PRIMARY KEY,
      family_id INTEGER,
      from_member INTEGER,
      type TEXT,
      status TEXT DEFAULT 'pending',
      original_text TEXT,
      ai_reply TEXT,
      child_reply_audio TEXT,
      reply_video TEXT,
      reply_text TEXT,
      reminded INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      viewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS quota_usage (
      family_id INTEGER,
      month TEXT,
      video_seconds REAL DEFAULT 0,
      video_count INTEGER DEFAULT 0,
      PRIMARY KEY (family_id, month)
    );
  `);

  seed();

  console.log('[Family] SQLite 初始化完成:', FAMILY_DB_PATH);
  return db;
}

/**
 * 幂等 seed：family(id=1) + child member + parent member。
 * - family 不存在才插入；存在则不动（不覆盖用户已确认状态 / 名称）。
 * - member 按 role 判断是否已存在；不存在才插入，invite_code 用 env 默认值。
 *   已存在的 member 不覆盖其 invite_code（库优先于 env，见 decisions / regenInviteCode）。
 */
function seed() {
  const now = Date.now();

  // family id=1
  const fam = db.prepare('SELECT id FROM family WHERE id = 1').get();
  if (!fam) {
    db.prepare('INSERT INTO family (id, name, confirmed, created_at) VALUES (1, ?, 0, ?)')
      .run('我的家', now);
    console.log('[Family] seed family(id=1)');
  }

  // child / parent member（按 role 幂等）
  seedMember('child', '小军', envChildCode(), now);
  seedMember('parent', '妈', envParentCode(), now);
}

/**
 * 单个成员 seed：family_id=1 下不存在该 role 才插入。
 * invite_code 冲突（被另一成员占用）时，回退为不带 code 占位，避免 UNIQUE 崩库。
 */
function seedMember(role, nickname, code, now) {
  const exist = db.prepare('SELECT id FROM member WHERE family_id = 1 AND role = ?').get(role);
  if (exist) return;

  // 防御：env 给的 child/parent code 万一相同，第二个会撞 UNIQUE。撞了就先存 null。
  let finalCode = code;
  const codeTaken = db.prepare('SELECT id FROM member WHERE invite_code = ?').get(code);
  if (codeTaken) {
    console.warn(`[Family] seed ${role} 的 invite_code 与已有成员冲突，先置空，请用 regenInviteCode 重设`);
    finalCode = null;
  }

  db.prepare(
    'INSERT INTO member (family_id, role, nickname, invite_code, last_active, created_at) VALUES (1, ?, ?, ?, ?, ?)'
  ).run(role, nickname, finalCode, null, now);
  console.log(`[Family] seed member role=${role} code=${finalCode}`);
}

// ── 家庭读写 ─────────────────────────────────────────────────

/**
 * 取家庭信息 + 成员列表。
 * → { id, name, confirmed, members: [{ id, role, nickname, invite_code, last_active }] } | null
 */
export function getFamily(familyId) {
  if (!db) return null;
  const fam = db.prepare('SELECT id, name, confirmed, created_at FROM family WHERE id = ?').get(familyId);
  if (!fam) return null;

  const members = db
    .prepare('SELECT id, role, nickname, invite_code, last_active, created_at FROM member WHERE family_id = ? ORDER BY id')
    .all(familyId);

  return {
    id: fam.id,
    name: fam.name,
    confirmed: fam.confirmed === 1,
    members,
  };
}

/** 标记家庭「试看已确认」 */
export function setFamilyConfirmed(familyId) {
  if (!db) return false;
  const r = db.prepare('UPDATE family SET confirmed = 1 WHERE id = ?').run(familyId);
  return r.changes > 0;
}

// ── 成员读写 ─────────────────────────────────────────────────

/**
 * 用邀请码解析成员（中间件用）。
 * → { id, familyId, role, nickname } | null
 */
export function resolveMemberByCode(code) {
  if (!db || !code) return null;
  const m = db
    .prepare('SELECT id, family_id, role, nickname FROM member WHERE invite_code = ?')
    .get(code);
  if (!m) return null;
  return { id: m.id, familyId: m.family_id, role: m.role, nickname: m.nickname };
}

/** 更新成员 last_active 时间戳 */
export function touchMember(memberId) {
  if (!db || !memberId) return false;
  const r = db.prepare('UPDATE member SET last_active = ? WHERE id = ?').run(Date.now(), memberId);
  return r.changes > 0;
}

/**
 * 重新生成某角色的邀请码并写库。
 * → 新 code（成功）| null（家庭/角色不存在等异常）。
 *
 * 决策（契约 §1 未明说，本区域按此执行并写进 decisions）：
 *   库里的值优先于 env，env 只是首次 seed 默认。因此 regen 对 env 提供的 code 也允许覆盖——
 *   即便当前 member 的 invite_code 正好等于 env 默认值，仍照常生成新 code 覆盖。
 */
export function regenInviteCode(familyId, role) {
  if (!db) return null;
  const m = db.prepare('SELECT id FROM member WHERE family_id = ? AND role = ?').get(familyId, role);
  if (!m) {
    console.warn(`[Family] regenInviteCode 找不到成员 family=${familyId} role=${role}`);
    return null;
  }

  // 生成短易读邀请码：role 前缀 + 8 位随机（去掉易混字符）。撞 UNIQUE 时重试几次。
  let newCode = null;
  for (let i = 0; i < 5; i++) {
    const candidate = makeCode(role);
    const taken = db.prepare('SELECT id FROM member WHERE invite_code = ?').get(candidate);
    if (!taken) { newCode = candidate; break; }
  }
  if (!newCode) {
    console.warn('[Family] regenInviteCode 多次随机均撞码，放弃');
    return null;
  }

  db.prepare('UPDATE member SET invite_code = ? WHERE id = ?').run(newCode, m.id);
  console.log(`[Family] regenInviteCode role=${role} → ${newCode}`);
  return newCode;
}

/** 生成一个不易混淆的邀请码（避免 0/O、1/l/I） */
function makeCode(role) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  const prefix = role === 'parent' ? 'p' : 'c';
  return `${prefix}-${s}`;
}

// ── 双口令 / 角色中间件（契约 §5.1）─────────────────────────────

/**
 * 返回一个 Express 中间件函数，替换现有 ACCESS_CODE 中间件，行为向后兼容。
 *
 * 规则（契约 §5.1）：
 *   1) 任一 code 已配置（口令模式）：
 *      - 解析 ?code= / cookie twin_code → resolveMemberByCode → req.member={id,familyId,role}
 *      - 命中则种 cookie（30 天免输，沿用现实现）并放行；touch 成员活跃时间
 *      - 无效 → 401（沿用现拦截页文案风格）
 *      - 静态资源放行逻辑与现实现一致：现实现并不单独放行静态资源（中间件对所有请求生效，
 *        靠 cookie/?code 通过），这里保持一致，不额外开静态白名单。
 *   2) 全部 code 未配置（本地裸跑）：
 *      - 默认 req.member={ familyId:1, role: X-Twin-Role==='parent' ? 'parent' : 'child' }
 *      - 前端按路由带 X-Twin-Role 头
 */
export function authMiddleware() {
  const codeMode = !noCodeConfigured();

  if (!codeMode) {
    console.log('[Family] authMiddleware：本地裸跑模式（无任何 code），按 X-Twin-Role 头分角色');
  } else {
    console.log('[Family] authMiddleware：口令模式（解析 ?code= / cookie twin_code）');
  }

  return (req, res, next) => {
    // ── 裸跑模式：默认 family 1，角色看请求头 ──
    if (!codeMode) {
      const role = req.get('X-Twin-Role') === 'parent' ? 'parent' : 'child';
      req.member = { familyId: 1, role };
      return next();
    }

    // ── 口令模式 ──
    // 1) cookie twin_code 优先（已登录免输）
    const cookies = Object.fromEntries(
      (req.headers.cookie || '')
        .split(';')
        .map((s) => s.trim().split('='))
        .filter((p) => p.length === 2)
    );
    let code = cookies.twin_code || null;

    // 2) URL ?code= 次之（线上口令链接），命中则种 cookie
    let fromQuery = false;
    if (!code || !resolveMemberByCode(code)) {
      let q = null;
      try {
        q = new URL(req.url, 'http://placeholder').searchParams.get('code');
      } catch (_) {
        q = null;
      }
      if (q) {
        code = q;
        fromQuery = true;
      }
    }

    const member = resolveMemberByCode(code);
    if (member) {
      req.member = { id: member.id, familyId: member.familyId, role: member.role };
      if (fromQuery) {
        // 沿用现实现：种 cookie 30 天免输
        res.setHeader(
          'Set-Cookie',
          `twin_code=${code}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`
        );
      }
      // 记录活跃（非阻塞容错）
      try { touchMember(member.id); } catch (_) {}
      return next();
    }

    // 无效 → 401 拦截页（沿用现实现文案风格）
    res
      .status(401)
      .send(
        '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding-top:20vh;background:#f4effb;color:#4a3f70;"><h2>🔒 小忆 · 家庭访问</h2><p>需要访问口令：请用 <code>?code=口令</code> 形式的完整链接访问</p></body>'
      );
  };
}
