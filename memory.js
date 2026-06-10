/**
 * memory.js — 阶段 4：轻量自建记忆层
 *
 * 架构：
 *   - 存储：Node 24 内置 node:sqlite（零依赖），数据落在 data/memory.db
 *   - 检索：优先 Ollama embedding 向量余弦相似度；Ollama 未就绪时自动降级到关键词匹配
 *   - 写入：对话结束后异步抽取，不阻塞回复流
 *
 * 记忆分两类：
 *   profile  — 用户画像（稳定事实：称呼、身份、偏好等），每用户一份 JSON
 *   memory   — 对话记忆（重要事件/经历），带时间戳，可多条
 */

import { DatabaseSync } from 'node:sqlite';
import http from 'http';
import https from 'https';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── 配置 ─────────────────────────────────────────────────────
const MEMORY_ENABLED = process.env.MEMORY_ENABLED !== 'false'; // 默认开启
const MEMORY_DB_PATH = join(__dirname, process.env.MEMORY_DB || 'data/memory.db');
const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
const MEMORY_TOPK = parseInt(process.env.MEMORY_TOPK || '4', 10);
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';

// ── 初始化 SQLite ────────────────────────────────────────────
let db = null;

function initDb() {
  if (!MEMORY_ENABLED) return;

  // 确保 data 目录存在
  const dir = dirname(MEMORY_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    db = new DatabaseSync(MEMORY_DB_PATH);

    // memories 表：对话记忆
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'convo',
        embedding TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    // profile 表：用户画像（key-value 形式，灵活扩展）
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      )
    `);

    console.log('[Memory] SQLite 初始化完成:', MEMORY_DB_PATH);
  } catch (err) {
    console.error('[Memory] SQLite 初始化失败:', err.message);
    db = null;
  }
}

// ── Embedding 工具 ───────────────────────────────────────────

/**
 * 调 Ollama /api/embeddings 获取文本向量
 * 失败时返回 null（触发降级到关键词匹配）
 */
function getEmbedding(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, prompt: text });
    const urlObj = new URL(`${OLLAMA_BASE}/api/embeddings`);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000, // embedding 通常很快，10s 超时足够
    };

    const req = transport.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.embedding && Array.isArray(parsed.embedding)) {
            resolve(parsed.embedding);
          } else {
            resolve(null);
          }
        } catch (_) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/** 余弦相似度（两个 number[] 向量） */
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── 关键词降级检索 ────────────────────────────────────────────

/**
 * 简单关键词匹配：把查询切词，统计记忆里包含了几个词
 * 返回按命中数降序排列的 top-k 条
 */
function keywordSearch(query, memories, topK) {
  // 简单分词：按空格、标点切，过滤空串，去重
  const queryTokens = new Set(
    query
      .split(/[\s，。！？、：；""''（）【】\n]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2) // 太短的词（1 个字）噪音多，忽略
  );

  if (queryTokens.size === 0) {
    // 没有有效关键词，返回最新的几条
    return memories.slice(0, topK);
  }

  const scored = memories.map(mem => {
    let hits = 0;
    for (const token of queryTokens) {
      if (mem.content.includes(token)) hits++;
    }
    return { ...mem, _score: hits };
  });

  return scored
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, topK);
}

// ── 核心 API ─────────────────────────────────────────────────

/**
 * 检索与 query 相关的记忆（向量或关键词）
 * 返回 top-k 条记忆对象数组
 */
async function searchMemories(query, topK = MEMORY_TOPK) {
  if (!db || !MEMORY_ENABLED) return [];

  // 取所有记忆（小数据量下全拿没问题，千条以下无感）
  const allMemories = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
  if (allMemories.length === 0) return [];

  // 尝试向量检索
  const queryEmbedding = await getEmbedding(query);
  if (queryEmbedding) {
    // 对每条有 embedding 的记忆算相似度
    const scored = allMemories.map(mem => {
      let sim = 0;
      if (mem.embedding) {
        try {
          const memVec = JSON.parse(mem.embedding);
          sim = cosineSim(queryEmbedding, memVec);
        } catch (_) {}
      }
      return { ...mem, _score: sim };
    });
    const result = scored
      .sort((a, b) => b._score - a._score)
      .slice(0, topK)
      .filter(m => m._score > 0.1); // 相似度太低的不要（阈值可调）

    if (result.length > 0) {
      console.log(`[Memory] 向量检索到 ${result.length} 条相关记忆（top 相似度: ${result[0]._score.toFixed(3)}）`);
      return result;
    }
    // 向量检索结果为空（可能是都没有 embedding），降级关键词
  } else {
    console.log('[Memory] Embedding 未就绪，降级到关键词检索');
  }

  // 关键词降级
  const kwResult = keywordSearch(query, allMemories, topK);
  console.log(`[Memory] 关键词检索到 ${kwResult.length} 条相关记忆`);
  return kwResult;
}

/**
 * 把记忆 + 用户画像拼成注入 system prompt 的文本段
 */
async function buildMemoryContext(userMessage) {
  if (!db || !MEMORY_ENABLED) return '';

  const profile = getProfile();
  const memories = await searchMemories(userMessage);

  const parts = [];

  // 用户画像
  if (Object.keys(profile).length > 0) {
    const profileLines = Object.entries(profile)
      .map(([k, v]) => `- ${k}：${v}`)
      .join('\n');
    parts.push(`【关于这位用户你已知道】\n${profileLines}`);
  }

  // 相关记忆
  if (memories.length > 0) {
    const memLines = memories
      .map(m => `- [${m.created_at}] ${m.content}`)
      .join('\n');
    parts.push(`【相关对话记忆】\n${memLines}`);
  }

  if (parts.length === 0) return '';

  return '\n\n' + parts.join('\n\n') + '\n\n（以上是关于用户的背景信息，自然融入回答中，不要显式说"根据你的记忆"之类的话）';
}

/**
 * 用 Ollama 从用户消息里异步抽取记忆（不阻塞回复流）
 * 触发条件：消息里含有关键词（我叫/我是/我喜欢/我在/我想/我有/我的），或每 5 轮强制抽一次
 */
async function extractAndSaveMemory(userMessage, assistantReply, turnCount) {
  if (!db || !MEMORY_ENABLED) return;

  // 简单触发规则：特定关键词 or 每 5 轮
  const triggerKeywords = ['我叫', '我是', '我喜欢', '我在', '我想', '我有', '我的', '我正在', '我需要', '我希望', '我觉得', '我认为'];
  const hasKeyword = triggerKeywords.some(kw => userMessage.includes(kw));
  const isForcedTurn = turnCount > 0 && turnCount % 5 === 0;

  if (!hasKeyword && !isForcedTurn) return;

  console.log(`[Memory] 触发抽取（keyword=${hasKeyword}, forcedTurn=${isForcedTurn}）`);

  // 调 Ollama 做结构化抽取
  try {
    const extractPrompt = `你是一个记忆抽取助手。从下面这段对话中，判断用户说了什么值得长期记住的信息。

用户说：${userMessage}
城北回复：${assistantReply || '（无）'}

请判断（以用户说的内容为主，城北的回复仅作上下文参考）：
1. 有没有用户的**个人信息**？如果有，以 JSON 格式返回：{"type":"profile","key":"字段名","value":"值"}
   - key 用规范字段名，固定从这几个里选：姓名、职业、爱好、设备、目标、学习偏好。不要自创"名字""称呼"这种近义 key。
   - value 必须是具体的事实，**绝不能是"你/我/他/它"这类代词或空值**——这种情况当作没有个人信息。
2. 有没有值得记住的**重要事件或经历**（情绪、重大事件、特定经历）？如果有，返回：{"type":"memory","content":"一句话总结"}
3. 如果没有值得记住的信息，返回：{"type":"none"}

只返回一个 JSON 对象，不要其他任何文字。`;

    const endpoint = {
      url: OLLAMA_BASE.replace(/\/$/, '') + '/v1/chat/completions',
      model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
      apiKey: 'ollama',
    };

    const result = await callLlmJson(endpoint, extractPrompt);
    if (!result || result.type === 'none') return;

    if (result.type === 'profile' && result.key && result.value) {
      // 硬过滤：挡掉代词/空值/过短的无意义画像（LLM 偶尔不遵守 prompt 规范）
      const pronouns = ['你', '我', '他', '她', '它', '您', '咱', '人家'];
      const val = String(result.value).trim();
      if (!val || pronouns.includes(val) || val.length < 1) {
        console.log(`[Memory] 跳过无意义画像: ${result.key} = ${result.value}`);
        return;
      }
      // 近义 key 归一化，避免"名字/称呼"和"姓名"并存
      const keyMap = { '名字': '姓名', '称呼': '姓名', '昵称': '姓名', '工作': '职业' };
      const normKey = keyMap[result.key] || result.key;
      saveProfile(normKey, val);
      console.log(`[Memory] 保存画像: ${normKey} = ${val}`);
    } else if (result.type === 'memory' && result.content) {
      await saveMemory(result.content, 'convo');
      console.log(`[Memory] 保存记忆: ${result.content}`);
    }
  } catch (err) {
    console.warn('[Memory] 抽取失败（非阻塞）:', err.message);
  }
}

/**
 * 调 LLM 返回 JSON（用于记忆抽取）
 */
function callLlmJson(endpoint, prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: endpoint.model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
    });

    const urlObj = new URL(endpoint.url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${endpoint.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    };

    const req = transport.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const content = parsed.choices?.[0]?.message?.content || '';
          // 从 content 里抠出 JSON（可能被 ``` 包裹）
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resolve(JSON.parse(jsonMatch[0]));
          } else {
            resolve(null);
          }
        } catch (_) {
          resolve(null);
        }
      });
      res.on('error', () => resolve(null));
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── 记忆 CRUD ────────────────────────────────────────────────

/**
 * 保存一条记忆（同时异步计算 embedding）
 */
async function saveMemory(content, type = 'convo') {
  if (!db) return null;

  const stmt = db.prepare(`
    INSERT INTO memories (content, type, embedding)
    VALUES (?, ?, NULL)
  `);
  const result = stmt.run(content, type);
  const id = Number(result.lastInsertRowid);

  // 异步计算 embedding，不阻塞调用方
  getEmbedding(content).then(embedding => {
    if (embedding && db) {
      try {
        db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
          .run(JSON.stringify(embedding), id);
        console.log(`[Memory] Embedding 已更新 (id=${id})`);
      } catch (_) {}
    }
  });

  return id;
}

/** 获取所有记忆（不含 embedding 字段，体积太大） */
function getAllMemories() {
  if (!db) return [];
  return db.prepare('SELECT id, content, type, created_at, updated_at FROM memories ORDER BY created_at DESC').all();
}

/** 删除一条记忆 */
function deleteMemory(id) {
  if (!db) return false;
  const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  return result.changes > 0;
}

/** 更新一条记忆内容 */
async function updateMemory(id, content) {
  if (!db) return false;
  const result = db.prepare(`
    UPDATE memories SET content = ?, embedding = NULL, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(content, id);
  if (result.changes > 0) {
    // 异步重新计算 embedding
    getEmbedding(content).then(embedding => {
      if (embedding && db) {
        try {
          db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
            .run(JSON.stringify(embedding), id);
        } catch (_) {}
      }
    });
    return true;
  }
  return false;
}

// ── 用户画像 CRUD ─────────────────────────────────────────────

/** 获取整份用户画像（key-value 对象） */
function getProfile() {
  if (!db) return {};
  const rows = db.prepare('SELECT key, value FROM profile').all();
  const profile = {};
  for (const row of rows) {
    profile[row.key] = row.value;
  }
  return profile;
}

/** 保存/更新画像字段 */
function saveProfile(key, value) {
  if (!db) return;
  db.prepare(`
    INSERT INTO profile (key, value, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

/** 整体更新画像（传入完整 key-value 对象） */
function setProfile(profileObj) {
  if (!db) return;
  // 在事务里批量更新
  const upsert = db.prepare(`
    INSERT INTO profile (key, value, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  // 先清掉不在新对象里的 key
  const existingKeys = db.prepare('SELECT key FROM profile').all().map(r => r.key);
  const newKeys = Object.keys(profileObj);
  for (const key of existingKeys) {
    if (!newKeys.includes(key)) {
      db.prepare('DELETE FROM profile WHERE key = ?').run(key);
    }
  }
  for (const [key, value] of Object.entries(profileObj)) {
    if (value !== null && value !== undefined && String(value).trim()) {
      upsert.run(key, String(value).trim());
    }
  }
}

// ── 导出 ─────────────────────────────────────────────────────
export {
  MEMORY_ENABLED,
  getEmbedding,
  cosineSim,
  initDb,
  buildMemoryContext,
  extractAndSaveMemory,
  saveMemory,
  getAllMemories,
  deleteMemory,
  updateMemory,
  getProfile,
  saveProfile,
  setProfile,
};
