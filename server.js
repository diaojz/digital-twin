/**
 * 数字分身助手 - 后端服务（阶段 4：记忆层 + 阶段 0-3 全能力）
 *
 * 架构说明：
 * - 用 Express 做轻量 HTTP 服务
 * - 静态文件从 public/ 目录提供（前端 HTML/CSS/JS）
 * - POST /api/chat       接收消息 → 注入记忆上下文 → 转发给 LLM → 流式返回（SSE）→ 异步抽取记忆
 * - POST /api/tts        文字转语音（阶段 1）
 * - POST /api/asr        语音识别（阶段 2）
 * - GET  /api/memory     获取所有记忆（记忆管理页）
 * - POST /api/memory     手动添加一条记忆
 * - DELETE /api/memory/:id  删除记忆
 * - PATCH /api/memory/:id   编辑记忆
 * - GET  /api/profile    获取用户画像
 * - PUT  /api/profile    更新用户画像
 */

import express from 'express';
import http from 'http';
import https from 'https';
import { readFileSync, existsSync, unlinkSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { StringDecoder } from 'string_decoder';
import { spawn } from 'child_process';
import os from 'os';
import { createHash } from 'crypto';
import {
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
  setProfile,
} from './memory.js';
import { tts as dashscopeTts, genFigure, emoDetect, emoGen } from './realhuman/api.js';

// ── 读取 .env 文件（如果存在） ──────────────────────────────
// Node 24 原生支持 --env-file 参数，但为了兼容旧版本，这里手动解析
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    // 跳过注释和空行
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    // 不覆盖已有的环境变量（process.env 优先）
    if (!process.env[key]) process.env[key] = val;
  }
  console.log('[Config] 已加载 .env 文件');
} else {
  console.log('[Config] 未找到 .env，使用默认配置（Ollama 本地模式）');
}

// ── 初始化记忆数据库 ──────────────────────────────────────────
// 在读取配置之前初始化，因为 initDb 依赖 OLLAMA_BASE 等环境变量
// 这里提前调用，之后 server 启动后会看到日志
initDb();

// ── 读取配置 ────────────────────────────────────────────────
const config = {
  provider: process.env.LLM_PROVIDER || 'ollama',
  ollama: {
    base: process.env.OLLAMA_BASE || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  },
  gateway: {
    base: process.env.GATEWAY_BASE || 'https://gw.diaoye.org/v1',
    key: process.env.GATEWAY_KEY || '',
    model: process.env.GATEWAY_MODEL || 'claude-sonnet-4-5',
  },
  dashscope: {
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    key: process.env.DASHSCOPE_API_KEY || '',
    model: 'qwen3-max',
  },
  port: parseInt(process.env.PORT || '3000', 10),
  // TTS 配置（阶段 1）
  tts: {
    enabled: process.env.TTS_ENABLED !== 'false', // 默认开启
    provider: process.env.TTS_PROVIDER || 'say',  // say | kokoro
    voice: process.env.TTS_VOICE || 'Tingting',   // say 模式用 Tingting；kokoro 模式用 zf_xiaoxiao
    serviceUrl: process.env.TTS_SERVICE_URL || 'http://127.0.0.1:8000',
  },
  // ASR 配置（阶段 2）
  asr: {
    enabled: process.env.ASR_ENABLED !== 'false', // 默认开启
    provider: process.env.ASR_PROVIDER || 'webspeech', // webspeech | whisper
    serviceUrl: process.env.ASR_SERVICE_URL || 'http://127.0.0.1:8001',
    model: process.env.ASR_MODEL || 'mlx-community/whisper-large-v3-turbo',
  },
  // 记忆配置（阶段 4）
  memory: {
    enabled: MEMORY_ENABLED,
  },
  // 语音打断配置（阶段 5）
  bargeIn: {
    enabled: process.env.BARGE_IN_ENABLED !== 'false', // 默认开启
  },
  // 唤醒词配置（阶段 5）
  wakeWord: {
    enabled: process.env.WAKE_WORD_ENABLED !== 'false', // 默认开启
    words: (process.env.WAKE_WORDS || '城北').split(',').map(w => w.trim()).filter(Boolean),
  },
  // 形象 Provider 配置（阶段 6）
  // live2d = 本地卡通形象（默认，开箱即用）
  // realhuman = 云端真人写实形象（需要配置 REALHUMAN_SERVICE_URL）
  avatar: {
    provider: process.env.AVATAR_PROVIDER || 'live2d',
    realHumanServiceUrl: process.env.REALHUMAN_SERVICE_URL || '',
  },
};

// 根据 provider 组装实际调用的端点和鉴权
function getLlmEndpoint() {
  if (config.provider === 'gateway') {
    return {
      url: config.gateway.base.replace(/\/$/, '') + '/chat/completions',
      model: config.gateway.model,
      apiKey: config.gateway.key,
    };
  }
  if (config.provider === 'dashscope') {
    return {
      url: config.dashscope.base.replace(/\/$/, '') + '/chat/completions',
      model: config.dashscope.model,
      apiKey: config.dashscope.key,
    };
  }
  // 默认 ollama，使用 OpenAI 兼容端点
  return {
    url: config.ollama.base.replace(/\/$/, '') + '/v1/chat/completions',
    model: config.ollama.model,
    apiKey: 'ollama', // Ollama 不需要真实 key，随便填一个防止格式校验报错
  };
}

console.log(`[Config] LLM_PROVIDER=${config.provider}`);
if (config.provider === 'gateway') {
  console.log(`[Config] Gateway: ${config.gateway.base}, model=${config.gateway.model}`);
} else if (config.provider === 'dashscope') {
  console.log(`[Config] DashScope: ${config.dashscope.base}, model=${config.dashscope.model}`);
} else {
  console.log(`[Config] Ollama: ${config.ollama.base}, model=${config.ollama.model}`);
}
console.log(`[Config] TTS_ENABLED=${config.tts.enabled}, TTS_PROVIDER=${config.tts.provider}, TTS_VOICE=${config.tts.voice}`);
console.log(`[Config] ASR_ENABLED=${config.asr.enabled}, ASR_PROVIDER=${config.asr.provider}`);
console.log(`[Config] MEMORY_ENABLED=${config.memory.enabled}`);
console.log(`[Config] BARGE_IN_ENABLED=${config.bargeIn.enabled}`);
console.log(`[Config] WAKE_WORD_ENABLED=${config.wakeWord.enabled}, WAKE_WORDS=${config.wakeWord.words.join(',')}`);
console.log(`[Config] AVATAR_PROVIDER=${config.avatar.provider}, REALHUMAN_SERVICE_URL=${config.avatar.realHumanServiceUrl || '(未配置)'}`);


// ── 城北的系统提示词 ────────────────────────────────────────
// 这是"数字分身"的人设核心，教学场景下温暖、鼓励、面向零基础学员
const BASE_SYSTEM_PROMPT = `你是城北，一个温暖、亲切的数字分身学习助手。你陪伴的学员是零基础的 AI 开发初学者，他们在学习如何用 AI 工具做开发、搭 App、上架 App Store。

你的性格特点：
- 温暖有耐心：学员问任何问题都不会被嘲笑，你会鼓励他们
- 口语化：用自然的口语回答，不要太书面，少用术语，用了也要解释
- 先鼓励再解答：先肯定学员的努力或提问，再给出实质帮助
- 简洁明了：不废话，不过度渲染，给出能直接用的建议
- 贴近场景：回答要贴近「AI 开发学习」这个具体场景
- 记住用户说过的事：如果你知道用户的称呼、背景，自然地用起来，让对话更有温度

重要约束：
- 回答长度控制在 100-200 字以内（对话场景，不是写文章）
- 不要说"作为一个 AI"之类的套话
- 如果不知道某件事，直接说不知道，不要编造`;

// 对话轮次计数（用于触发强制记忆抽取）
let turnCount = 0;

// 真人形象缓存（阶段 6 realhuman 模式）
// 结构：{ imageUrl: string, faceBbox: number[], extBbox: number[] }
// null 表示尚未生成形象
// 持久化到 data/，避免 node 重启后形象丢失（否则每次重启都要重新生成）
const FIGURE_CACHE_FILE = join(__dirname, 'data', 'realhuman-figure.json');
// 形象图本地缓存目录（下载到 public/ 下，前端直接访问，不依赖 24h 临时 URL）
const AVATAR_DIR = join(__dirname, 'public', 'avatars');
const AVATAR_FILE = join(AVATAR_DIR, 'current.png');

// 把生成的形象图下载到本地，返回前端可访问的相对路径
async function downloadFigure(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error('下载形象图失败 HTTP ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, { recursive: true });
  writeFileSync(AVATAR_FILE, buf);
  return '/avatars/current.png';
}

// 对口型视频本地缓存 = 「话术库」：预生成的每句话存下 原文 + 句向量 + 视频。
// 命中分三层（一层比一层宽松）：
//   1. 精确命中：文字+音色+语音参数+形象 完全一致（MD5 键）
//   2. 归一化命中：去掉标点/空格后文字相同（同一形象下）
//   3. 语义命中：LLM 回复和库里某句意思相近（Ollama embedding 余弦相似度 ≥ 阈值）
// 后两层命中时会把「库里那句」当作最终回复返回给前端（matchedText），保证嘴型和字幕一致。
const VIDEO_DIR = join(__dirname, 'public', 'avatars', 'videos');
const SPEAK_CACHE_FILE = join(__dirname, 'data', 'realhuman-speak-cache.json');
// 阈值按 nomic-embed-text 中文实测校准：同义句 0.77~1.00，不同义句 0.57~0.72，0.75 刚好分界
const SPEAK_MATCH_THRESHOLD = parseFloat(process.env.SPEAK_MATCH_THRESHOLD || '0.75');
let speakCache = {};   // { cacheKey: { path, text, voice, figVer, embedding } }
try {
  if (existsSync(SPEAK_CACHE_FILE)) speakCache = JSON.parse(readFileSync(SPEAK_CACHE_FILE, 'utf-8'));
  // 老格式兼容：早期索引的值是纯路径字符串（没存原文），包成对象，仍可精确命中，只是参与不了语义匹配
  for (const k of Object.keys(speakCache)) {
    if (typeof speakCache[k] === 'string') speakCache[k] = { path: speakCache[k] };
  }
} catch (e) { console.warn('[RealHuman] 视频缓存索引读取失败（忽略）:', e.message); }

function speakCacheKey(parts) {
  return createHash('md5').update(JSON.stringify(parts)).digest('hex');
}

// 文本归一化：去掉标点、空白，转小写——只比"说了什么字"，不比怎么断句
function normalizeSpeakText(t) {
  return t.replace(/[\s，。！？、：；·…—～~""''（）【】《》,.!?:;'"()\[\]<>-]+/g, '').toLowerCase();
}

/**
 * 在话术库里找和 text 意思相近的一句（仅限当前形象的条目）
 * 返回 { entry, sim, how } 或 null
 */
async function findSpeakMatch(text, figVer) {
  const candidates = Object.values(speakCache).filter(e => e.text && e.figVer === figVer);
  if (candidates.length === 0) return null;

  // 第 2 层：归一化全等（不需要 embedding，标点/空格差异直接命中）
  const norm = normalizeSpeakText(text);
  for (const e of candidates) {
    if (normalizeSpeakText(e.text) === norm) return { entry: e, sim: 1, how: '归一化全等' };
  }

  // 第 3 层：语义相似（Ollama embedding 未就绪时静默跳过，不影响正常生成链路）
  const queryVec = await getEmbedding(text);
  if (!queryVec) return null;
  let best = null;
  for (const e of candidates) {
    if (!e.embedding) continue;
    const sim = cosineSim(queryVec, e.embedding);
    if (!best || sim > best.sim) best = { entry: e, sim, how: '语义相似' };
  }
  return best && best.sim >= SPEAK_MATCH_THRESHOLD ? best : null;
}
async function downloadVideo(videoUrl, key) {
  const resp = await fetch(videoUrl);
  if (!resp.ok) throw new Error('下载视频失败 HTTP ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });
  writeFileSync(join(VIDEO_DIR, key + '.mp4'), buf);
  return '/avatars/videos/' + key + '.mp4';
}
function clearSpeakCache() {
  speakCache = {};
  try { if (existsSync(SPEAK_CACHE_FILE)) unlinkSync(SPEAK_CACHE_FILE); } catch (_) {}
  try { if (existsSync(VIDEO_DIR)) for (const f of readdirSync(VIDEO_DIR)) unlinkSync(join(VIDEO_DIR, f)); } catch (_) {}
}
let rhFigure = null;
try {
  if (existsSync(FIGURE_CACHE_FILE)) {
    rhFigure = JSON.parse(readFileSync(FIGURE_CACHE_FILE, 'utf-8'));
    console.log('[RealHuman] 已从磁盘恢复形象缓存');
  }
} catch (e) {
  console.warn('[RealHuman] 形象缓存读取失败（忽略）:', e.message);
}

// ── Express 应用 ─────────────────────────────────────────────
const app = express();
app.use(express.json());

// 静态文件（前端 HTML、CSS、JS）
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // HTML 不缓存：前端改动刷新即生效（避免浏览器拿到旧页面，开发/演示友好）
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// ── POST /api/chat ───────────────────────────────────────────
/**
 * 请求体：{ messages: [{ role: 'user'|'assistant', content: string }, ...] }
 * 响应：SSE 流，每个 data 事件是一个 token 片段
 *
 * SSE 格式：
 *   data: {"delta":"..."}   ← 正常 token
 *   data: [DONE]            ← 流结束
 *   data: {"error":"..."}   ← 出错
 */
app.post('/api/chat', async (req, res) => {
  const { messages, persona } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 字段不能为空' });
  }

  // 阶段 4：检索相关记忆 + 用户画像，拼进 system prompt
  const userMessage = messages[messages.length - 1]?.content || '';
  const memoryContext = await buildMemoryContext(userMessage);
  // 配置面板「性格」：若前端传来 persona，则作为 system prompt 前缀注入，覆盖基础人设语气
  const personaPrefix = (persona && typeof persona === 'string' && persona.trim())
    ? persona.trim() + '\n\n'
    : '';
  const systemPrompt = personaPrefix + BASE_SYSTEM_PROMPT + memoryContext;

  if (memoryContext) {
    console.log('[Chat] 已注入记忆上下文（', memoryContext.length, '字符）');
  }

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 前端是同源（静态文件由本服务一起托管），无需 CORS。
  res.flushHeaders();

  // 组装发给 LLM 的请求体（OpenAI 兼容格式）
  const endpoint = getLlmEndpoint();
  const llmBody = JSON.stringify({
    model: endpoint.model,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  });

  let assistantReply = '';
  try {
    assistantReply = await callLlmStream(endpoint, llmBody, res);
  } catch (err) {
    console.error('[Chat] 转发出错:', err.message);
    // 如果响应还没发完，发一个错误事件
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }

  // 阶段 4：对话结束后，异步抽取记忆（不阻塞响应）
  turnCount++;
  if (userMessage && MEMORY_ENABLED) {
    setImmediate(() => {
      extractAndSaveMemory(userMessage, assistantReply, turnCount).catch(err => {
        console.warn('[Memory] 抽取出错（非阻塞）:', err.message);
      });
    });
  }
});

/**
 * 调用 LLM（OpenAI 兼容 SSE 流），把 token 逐字转发给浏览器
 * 这里手动用 Node http/https 模块，避免引入额外依赖（教学友好）
 */
function callLlmStream(endpoint, body, clientRes) {
  return new Promise((resolve, reject) => {
    let fullContent = ''; // 收集完整回复（用于记忆抽取）
    const urlObj = new URL(endpoint.url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${endpoint.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      // 给本地 Ollama 长一点的超时（模型冷启动慢）
      timeout: 120000,
    };

    console.log(`[Chat] 转发请求 → ${endpoint.url} (model: ${endpoint.model})`);

    const llmReq = transport.request(options, (llmRes) => {
      console.log(`[Chat] LLM 响应状态: ${llmRes.statusCode}`);

      if (llmRes.statusCode !== 200) {
        let errBody = '';
        llmRes.on('data', chunk => { errBody += chunk.toString(); });
        llmRes.on('end', () => {
          reject(new Error(`LLM 返回 ${llmRes.statusCode}: ${errBody.slice(0, 200)}`));
        });
        return;
      }

      let buffer = '';
      // 用 StringDecoder 而不是 chunk.toString()：中文 token 的 UTF-8 字节
      // 可能被 TCP 分包切成两半落在相邻 chunk 里，直接 toString 会在分界处
      // 产生乱码（�）。StringDecoder 会把不完整的多字节字符留到下一次拼接。
      const decoder = new StringDecoder('utf8');

      llmRes.on('data', (chunk) => {
        buffer += decoder.write(chunk);

        // SSE 是按行分割的，每行格式：`data: {...}` 或 `data: [DONE]`
        const lines = buffer.split('\n');
        // 最后一个可能不完整，留到下次处理
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;

          const raw = trimmed.slice(5).trim();
          if (raw === '[DONE]') {
            // 流结束，通知前端
            clientRes.write('data: [DONE]\n\n');
            continue;
          }

          try {
            const parsed = JSON.parse(raw);
            // OpenAI 流格式：choices[0].delta.content
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              // 把 token 转发给浏览器
              clientRes.write(`data: ${JSON.stringify({ delta })}\n\n`);
            }
          } catch (e) {
            // 跳过解析失败的行（有时会有空 data 或注释行）
          }
        }
      });

      llmRes.on('end', () => {
        console.log('[Chat] LLM 流结束');
        if (!clientRes.writableEnded) {
          clientRes.write('data: [DONE]\n\n');
          clientRes.end();
        }
        resolve(fullContent); // 返回完整回复，供记忆抽取使用
      });

      llmRes.on('error', (err) => {
        reject(err);
      });
    });

    llmReq.on('error', (err) => {
      reject(new Error(`连接 LLM 失败: ${err.message}（是否已启动 Ollama？）`));
    });

    llmReq.on('timeout', () => {
      llmReq.destroy();
      reject(new Error('LLM 响应超时（120s）'));
    });

    llmReq.write(body);
    llmReq.end();
  });
}

// ── POST /api/tts ─────────────────────────────────────────────
/**
 * 阶段 1：文字转语音
 * 请求体：{ text: string }
 * 响应：audio/wav 二进制流（24kHz / 16bit / 单声道）
 *
 * 支持两种 provider：
 * - say：macOS 内置 say 命令 + ffmpeg 转换，零依赖，开箱即用
 * - kokoro：转发给本地 Python FastAPI（tts_server.py），高质量中文语音
 */
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 字段不能为空' });
  }

  // 过滤掉不适合朗读的内容（代码块、纯符号等）
  const cleanText = text.trim().slice(0, 500); // 限制长度，防止单句太长

  try {
    if (config.tts.provider === 'kokoro') {
      await ttsKokoro(cleanText, config.tts.voice, res);
    } else {
      await ttsSay(cleanText, config.tts.voice, res);
    }
  } catch (err) {
    console.error('[TTS] 合成失败:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * say 模式 TTS：macOS 自带 say 命令 + ffmpeg 转格式
 * say → AIFF → ffmpeg → WAV(24kHz/16bit/单声道) → 返回给前端
 *
 * 为什么要转 WAV：浏览器 Audio API 能直接播放 WAV；AIFF 兼容性弱。
 * 为什么用临时文件而不是管道：say 不支持直接输出到 stdout，必须写文件。
 */
function ttsSay(text, voice, res) {
  return new Promise((resolve, reject) => {
    // 用时间戳避免并发冲突
    const tmpId = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const aiffPath = join(os.tmpdir(), `${tmpId}.aiff`);
    const wavPath = join(os.tmpdir(), `${tmpId}.wav`);

    console.log(`[TTS/say] 合成: "${text.slice(0, 30)}..." voice=${voice}`);

    // Step 1: say 命令合成 AIFF
    const sayProc = spawn('say', ['-v', voice, '-o', aiffPath, '--', text]);

    sayProc.on('error', (err) => {
      reject(new Error(`say 命令失败: ${err.message}`));
    });

    sayProc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`say 命令退出码 ${code}`));
      }

      // Step 2: ffmpeg 转换 AIFF → WAV(24kHz/16bit/mono)
      const ffmpegProc = spawn('ffmpeg', [
        '-y',            // 覆盖已有文件
        '-i', aiffPath,  // 输入 AIFF
        '-ar', '24000',  // 采样率 24kHz（Kokoro 也用这个，统一格式）
        '-ac', '1',      // 单声道
        '-sample_fmt', 's16', // 16bit PCM
        wavPath,         // 输出 WAV
      ]);

      ffmpegProc.on('error', (err) => {
        cleanupFiles(aiffPath, wavPath);
        reject(new Error(`ffmpeg 命令失败: ${err.message}（是否已安装 ffmpeg？brew install ffmpeg）`));
      });

      ffmpegProc.on('close', (ffCode) => {
        // 删掉 AIFF（已经不需要了）
        try { unlinkSync(aiffPath); } catch(_) {}

        if (ffCode !== 0) {
          try { unlinkSync(wavPath); } catch(_) {}
          return reject(new Error(`ffmpeg 退出码 ${ffCode}`));
        }

        // Step 3: 把 WAV 返回给前端
        try {
          const wavData = readFileSync(wavPath);
          res.setHeader('Content-Type', 'audio/wav');
          res.setHeader('Content-Length', wavData.length);
          res.end(wavData);
          console.log(`[TTS/say] 完成，wav 大小: ${wavData.length} bytes`);
        } catch (readErr) {
          reject(new Error(`读取 WAV 文件失败: ${readErr.message}`));
        } finally {
          try { unlinkSync(wavPath); } catch(_) {}
        }
        resolve();
      });
    });
  });
}

/**
 * kokoro 模式 TTS：转发到本地 Python FastAPI 服务（tts_server.py）
 * 服务地址通过 TTS_SERVICE_URL 配置（默认 http://127.0.0.1:8000）
 */
function ttsKokoro(text, voice, res) {
  return new Promise((resolve, reject) => {
    const serviceUrl = config.tts.serviceUrl;
    const kokoroVoice = voice || 'zf_xiaoxiao'; // kokoro 默认中文女声

    console.log(`[TTS/kokoro] 合成: "${text.slice(0, 30)}..." voice=${kokoroVoice}`);

    const body = JSON.stringify({ text, voice: kokoroVoice });
    const urlObj = new URL(`${serviceUrl}/tts`);
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
      timeout: 30000,
    };

    const kokoroReq = transport.request(options, (kokoroRes) => {
      if (kokoroRes.statusCode !== 200) {
        let errBody = '';
        kokoroRes.on('data', chunk => { errBody += chunk.toString(); });
        kokoroRes.on('end', () => {
          reject(new Error(`Kokoro 服务返回 ${kokoroRes.statusCode}: ${errBody.slice(0, 200)}`));
        });
        return;
      }

      // 把 kokoro 服务返回的 WAV 直接转发给前端
      res.setHeader('Content-Type', 'audio/wav');
      kokoroRes.pipe(res);

      kokoroRes.on('end', () => {
        console.log('[TTS/kokoro] 完成');
        resolve();
      });

      kokoroRes.on('error', reject);
    });

    kokoroReq.on('error', (err) => {
      reject(new Error(`连接 Kokoro 服务失败: ${err.message}（是否已启动 tts_server.py？）`));
    });

    kokoroReq.on('timeout', () => {
      kokoroReq.destroy();
      reject(new Error('Kokoro 服务响应超时（30s）'));
    });

    kokoroReq.write(body);
    kokoroReq.end();
  });
}

/** 清理临时文件（忽略不存在的文件） */
function cleanupFiles(...paths) {
  for (const p of paths) {
    try { unlinkSync(p); } catch(_) {}
  }
}

// ── POST /api/asr ─────────────────────────────────────────────
/**
 * 阶段 2：语音识别（ASR）
 *
 * webspeech 模式：前端直接用浏览器 Web Speech API，不需要后端参与。
 *   但前端仍可调用此端点做"能力探测"，后端返回 { provider, enabled } 即可。
 *
 * whisper 模式：
 *   请求体：multipart/form-data，字段名 audio，值为音频文件（webm/wav）
 *   后端把音频转存为临时 WAV → 转发给 asr_server.py（mlx-whisper FastAPI）
 *   响应：{ text: "识别出的文字" }
 */
app.post('/api/asr', async (req, res) => {
  if (!config.asr.enabled) {
    return res.status(503).json({ error: 'ASR 未开启（ASR_ENABLED=false）' });
  }

  // webspeech 模式：后端不做转写，只告诉前端 provider
  if (config.asr.provider === 'webspeech') {
    return res.json({ provider: 'webspeech', text: null });
  }

  // whisper 模式：接收前端上传的音频文件
  // 手动解析 multipart/form-data，避免引入 multer 等额外依赖
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('multipart/form-data')) {
    return res.status(400).json({ error: '请求必须是 multipart/form-data 格式（字段 audio）' });
  }

  const boundary = contentType.split('boundary=')[1];
  if (!boundary) {
    return res.status(400).json({ error: '缺少 multipart boundary' });
  }

  try {
    const audioBuffer = await extractAudioFromMultipart(req, boundary);
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: '未收到音频数据' });
    }

    // 把音频数据写入临时文件，再发给 asr_server.py
    const tmpPath = join(os.tmpdir(), `asr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.webm`);
    writeFileSync(tmpPath, audioBuffer);

    try {
      const text = await callAsrWhisper(tmpPath);
      res.json({ provider: 'whisper', text });
    } finally {
      try { unlinkSync(tmpPath); } catch(_) {}
    }
  } catch (err) {
    console.error('[ASR] 识别失败:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * 从 multipart/form-data 请求中提取 audio 字段的二进制数据
 * 手动解析，避免引入额外依赖
 */
function extractAudioFromMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from(`--${boundary}`);
        const parts = splitBuffer(body, boundaryBuf);

        for (const part of parts) {
          // 找 \r\n\r\n 分割 header 和 body
          const sep = Buffer.from('\r\n\r\n');
          const sepIdx = part.indexOf(sep);
          if (sepIdx === -1) continue;

          const headerStr = part.slice(0, sepIdx).toString('utf-8');
          // 检查是否是 audio 字段
          if (!headerStr.includes('name="audio"')) continue;

          // 数据部分去掉末尾的 \r\n（data 是 Buffer，没有 endsWith，按字节判断）
          let data = part.slice(sepIdx + sep.length);
          if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
            data = data.slice(0, -2);
          }

          return resolve(data);
        }
        resolve(null); // 没找到 audio 字段
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** 按 delimiter 拆分 Buffer，返回各段（去掉空段） */
function splitBuffer(buf, delimiter) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buf.indexOf(delimiter, start)) !== -1) {
    if (idx > start) parts.push(buf.slice(start, idx));
    start = idx + delimiter.length;
    // 跳过紧随其后的 \r\n
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
  }
  if (start < buf.length) parts.push(buf.slice(start));
  return parts.filter(p => p.length > 2);
}

/**
 * whisper 模式：把音频文件路径发给 asr_server.py（mlx-whisper FastAPI）
 * 服务地址通过 ASR_SERVICE_URL 配置（默认 http://127.0.0.1:8001）
 * 响应：{ text: "识别出的文字" }
 */
function callAsrWhisper(audioPath) {
  return new Promise((resolve, reject) => {
    const serviceUrl = config.asr.serviceUrl;
    console.log(`[ASR/whisper] 发送音频: ${audioPath}`);

    // 读取音频文件，用 multipart/form-data 发给 asr_server.py
    let audioData;
    try {
      audioData = readFileSync(audioPath);
    } catch (e) {
      return reject(new Error(`读取音频文件失败: ${e.message}`));
    }

    // 手动构造 multipart/form-data 请求体
    const boundary = `----FormBoundary${Date.now()}`;
    const filename = audioPath.split('/').pop();
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: audio/webm\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioData, footer]);

    const urlObj = new URL(`${serviceUrl}/asr`);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 180000,   // 首次会触发 asr_server 下载模型，给足时间（常规识别仅几秒）
    };

    const asrReq = transport.request(options, (asrRes) => {
      let respBody = '';
      asrRes.on('data', chunk => { respBody += chunk.toString(); });
      asrRes.on('end', () => {
        try {
          const parsed = JSON.parse(respBody);
          if (asrRes.statusCode !== 200) {
            return reject(new Error(`ASR 服务返回 ${asrRes.statusCode}: ${parsed.error || respBody}`));
          }
          console.log(`[ASR/whisper] 识别结果: "${parsed.text}"`);
          resolve(parsed.text || '');
        } catch (e) {
          reject(new Error(`解析 ASR 响应失败: ${respBody.slice(0, 200)}`));
        }
      });
      asrRes.on('error', reject);
    });

    asrReq.on('error', (err) => {
      reject(new Error(`连接 ASR 服务失败: ${err.message}（是否已启动 asr_server.py？）`));
    });

    asrReq.on('timeout', () => {
      asrReq.destroy();
      reject(new Error('ASR 服务响应超时（180s）'));
    });

    asrReq.write(body);
    asrReq.end();
  });
}

// ── 记忆 CRUD API（阶段 4）───────────────────────────────────

/**
 * GET /api/memory — 获取所有记忆列表
 */
app.get('/api/memory', (_req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启（MEMORY_ENABLED=false）' });
  }
  const memories = getAllMemories();
  res.json({ memories });
});

/**
 * POST /api/memory — 手动添加一条记忆
 * 请求体：{ content: string, type?: "convo"|"manual" }
 */
app.post('/api/memory', async (req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启' });
  }
  const { content, type = 'manual' } = req.body;
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content 字段不能为空' });
  }
  const id = await saveMemory(content.trim(), type);
  res.json({ id, content: content.trim(), type });
});

/**
 * DELETE /api/memory/:id — 删除一条记忆
 */
app.delete('/api/memory/:id', (req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启' });
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: '无效的 id' });
  }
  const ok = deleteMemory(id);
  if (ok) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '记忆不存在' });
  }
});

/**
 * PATCH /api/memory/:id — 编辑一条记忆
 * 请求体：{ content: string }
 */
app.patch('/api/memory/:id', async (req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启' });
  }
  const id = parseInt(req.params.id, 10);
  const { content } = req.body;
  if (isNaN(id) || !content || !content.trim()) {
    return res.status(400).json({ error: 'id 或 content 无效' });
  }
  const ok = await updateMemory(id, content.trim());
  if (ok) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: '记忆不存在' });
  }
});

/**
 * GET /api/profile — 获取用户画像
 */
app.get('/api/profile', (_req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启' });
  }
  const profile = getProfile();
  res.json({ profile });
});

/**
 * PUT /api/profile — 更新用户画像（全量替换）
 * 请求体：{ profile: { key: value, ... } }
 */
app.put('/api/profile', (req, res) => {
  if (!config.memory.enabled) {
    return res.status(503).json({ error: '记忆功能未开启' });
  }
  const { profile } = req.body;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    return res.status(400).json({ error: 'profile 必须是 key-value 对象' });
  }
  setProfile(profile);
  res.json({ success: true, profile: getProfile() });
});

// ── 形象配置端点（阶段 6）───────────────────────────────────
/**
 * GET /api/avatar/config
 * 返回当前形象 provider 配置，供前端判断渲染哪种形象。
 *
 * 响应：
 * {
 *   provider: "live2d" | "realhuman",
 *   realHumanReady: boolean,   // realhuman 时是否已配置 serviceUrl
 *   realHumanServiceUrl: string | null  // realhuman 时的服务地址（脱敏，仅返回是否已配置）
 * }
 *
 * 注意：只告诉前端"有没有配置"，不暴露实际地址（前端不需要知道）。
 */
app.get('/api/avatar/config', (_req, res) => {
  const { provider, realHumanServiceUrl } = config.avatar;
  res.json({
    provider,
    realHumanReady: provider === 'realhuman' && !!realHumanServiceUrl,
    // 真人服务地址由后端代理，前端不需要直接连，这里只返回是否已配置
    realHumanConfigured: !!realHumanServiceUrl,
    // 当前缓存的真人形象（若有）：优先本地图（持久、不过期）
    figure: rhFigure ? { imageUrl: rhFigure.imageUrl, localImage: rhFigure.localImage, version: rhFigure.version } : null,
  });
});

// ── 真人形象：重置（清缓存，下次需重新生成）─────────────────
app.delete('/api/avatar/realhuman/figure', (_req, res) => {
  rhFigure = null;
  try { if (existsSync(FIGURE_CACHE_FILE)) unlinkSync(FIGURE_CACHE_FILE); } catch (_) {}
  try { if (existsSync(AVATAR_FILE)) unlinkSync(AVATAR_FILE); } catch (_) {}
  clearSpeakCache();   // 换形象 → 旧对口型视频失效，一并清空
  console.log('[RealHuman] 形象与对口型视频缓存已重置');
  res.json({ ok: true });
});

// ── 对口型视频缓存：单独清除（不动形象）─────────────────────
app.delete('/api/avatar/realhuman/speak-cache', (_req, res) => {
  clearSpeakCache();
  console.log('[RealHuman] 对口型视频缓存已清除');
  res.json({ ok: true });
});

// ── 真人形象：生成形象图 + 检测人脸 ─────────────────────────
/**
 * POST /api/avatar/realhuman/figure
 * 请求体（可选）：{ prompt?: string }
 * 流程：文生图 → 人脸检测 → 缓存到 rhFigure → 返回
 * 耗时约 30-60s（异步任务轮询）
 */
app.post('/api/avatar/realhuman/figure', async (req, res) => {
  const DEFAULT_PROMPT = '一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量';
  const prompt = (req.body && req.body.prompt) ? req.body.prompt : DEFAULT_PROMPT;
  // 配置面板「画幅」：1:1 方形（省，1024*1024）/ 3:4 竖屏（默认，好看，720*1280）
  const ratio = (req.body && req.body.ratio === '1:1') ? '1:1' : '3:4';
  const size = ratio === '1:1' ? '1024*1024' : '720*1280';

  console.log('[RealHuman/figure] 开始生成形象，ratio:', ratio, 'prompt:', prompt.slice(0, 40) + '...');

  try {
    // Step 1: 文生图（失败则整体失败）
    console.log('[RealHuman/figure] 调用 genFigure...');
    const imageUrl = await genFigure(prompt, size);
    console.log('[RealHuman/figure] 图片 URL:', imageUrl);

    // Step 2: 人脸检测（EMO 服务）。失败不阻塞——降级为「只有静态形象、无对口型坐标」，
    //         让 EMO 未开通时也能展示写实形象 + 语音对话（PRD §6.1 降级不阻塞）。
    let faceBbox = [];
    let extBbox = [];
    let checkPass = false;
    let detectError = null;
    try {
      console.log('[RealHuman/figure] 调用 emoDetect...');
      const bbox = await emoDetect(imageUrl, ratio);
      console.log('[RealHuman/figure] emoDetect 结果:', JSON.stringify(bbox));
      faceBbox = bbox.face_bbox || [];
      extBbox = bbox.ext_bbox || [];
      checkPass = bbox.check_pass || false;
      if (!checkPass) detectError = '人脸检测未通过（check_pass=false），换一张图可重试对口型';
    } catch (e) {
      // 最常见：EMO（悦动人像）服务未开通 → 403。形象图仍可用，只是暂无对口型坐标。
      detectError = e.message;
      console.warn('[RealHuman/figure] emoDetect 失败（降级为仅静态形象）:', e.message);
    }

    // Step 3: 下载图片到本地永久缓存（避免 24h 临时 URL 过期，复用不重新生成）
    let localImage = null;
    try {
      localImage = await downloadFigure(imageUrl);
    } catch (e) {
      console.warn('[RealHuman] 形象图下载失败，回退用临时 URL:', e.message);
    }
    const version = Date.now();

    // Step 4: 缓存（即便无 bbox，也存供舞台静态展示）
    rhFigure = { imageUrl, localImage, faceBbox, extBbox, version };
    // 持久化到磁盘，node 重启后自动恢复
    try {
      writeFileSync(FIGURE_CACHE_FILE, JSON.stringify(rhFigure));
    } catch (e) {
      console.warn('[RealHuman] 形象缓存写入失败（忽略）:', e.message);
    }

    res.json({ imageUrl, localImage, version, faceBbox, extBbox, checkPass, detectError });
  } catch (err) {
    console.error('[RealHuman/figure] 文生图失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 真人形象：文字转说话视频 ─────────────────────────────────
/**
 * POST /api/avatar/realhuman/speak
 * 请求体：{ text: string, voice?: string }
 * 流程：TTS（CosyVoice）→ emoGen（对口型视频）→ 返回 videoUrl + audioUrl
 * 耗时约 1-3min（两步异步任务轮询）
 */
app.post('/api/avatar/realhuman/speak', async (req, res) => {
  const { text, voice, rate, pitch, volume, lipsync } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text 字段不能为空' });
  }

  const usedVoice = voice || 'longwan_v2';
  // 配置面板「语音微调」：仅透传前端确实给了的数值，其余用 api.js 默认
  const ttsOpts = { voice: usedVoice };
  if (typeof rate === 'number') ttsOpts.rate = rate;
  if (typeof pitch === 'number') ttsOpts.pitch = pitch;
  if (typeof volume === 'number') ttsOpts.volume = volume;
  console.log('[RealHuman/speak] 开始，text:', text.slice(0, 30) + '...', 'voice:', usedVoice);

  // 话术库第 1 层（精确命中）：「文字+音色+语音参数+形象」完全一致 → 秒回、不烧 EMO
  const figVer = (rhFigure && rhFigure.version) || 'noimg';
  const cacheKey = speakCacheKey({ text: text.trim(), voice: usedVoice, rate, pitch, volume, figVer });
  if (rhFigure && speakCache[cacheKey]) {
    const entry = speakCache[cacheKey];
    const localPath = join(__dirname, 'public', entry.path.replace(/^\//, ''));
    if (existsSync(localPath)) {
      // 老格式条目补登记：早期索引只存了路径没存原文。这次既然拿到了原文，
      // 补上原文 + 句向量（异步），老视频就也能参与语义匹配了——在设置里重输同一句话即可触发
      if (!entry.text) {
        entry.text = text.trim(); entry.voice = usedVoice; entry.figVer = figVer;
        writeFileSync(SPEAK_CACHE_FILE, JSON.stringify(speakCache));
        getEmbedding(text.trim()).then(vec => {
          if (vec) {
            entry.embedding = vec;
            try { writeFileSync(SPEAK_CACHE_FILE, JSON.stringify(speakCache)); } catch (_) {}
          }
        });
      }
      console.log('[RealHuman/speak] 精确命中视频缓存:', cacheKey);
      return res.json({ videoUrl: entry.path, cached: true });
    }
  }

  // 话术库第 2/3 层（归一化 / 语义命中）：LLM 回复和预生成的某句意思相近 → 直接复用那句的视频。
  // matchedText 返回库里的原句，前端会把字幕同步成它，保证「嘴上说的」和「屏幕显示的」一致。
  if (rhFigure) {
    const match = await findSpeakMatch(text.trim(), figVer);
    if (match) {
      const localPath = join(__dirname, 'public', match.entry.path.replace(/^\//, ''));
      if (existsSync(localPath)) {
        console.log(`[RealHuman/speak] 话术库命中（${match.how}，相似度 ${match.sim.toFixed(3)}）: ${match.entry.text.slice(0, 20)}...`);
        return res.json({ videoUrl: match.entry.path, cached: true, matchedText: match.entry.text });
      }
    }
  }

  // Step 1: TTS → 获取音频 URL（失败则整体失败，无可降级内容）
  let audioUrl;
  try {
    console.log('[RealHuman/speak] 调用 dashscope TTS...');
    audioUrl = await dashscopeTts(text.trim(), ttsOpts);
    console.log('[RealHuman/speak] 音频 URL:', audioUrl);
  } catch (err) {
    console.error('[RealHuman/speak] TTS 失败:', err.message);
    return res.status(500).json({ error: 'TTS 失败: ' + err.message });
  }

  // 没有形象 → 只返回语音（前端播声音 + 占位/默认形象），语音回复不依赖形象
  if (!rhFigure) {
    return res.json({ audioUrl, videoError: '尚未生成形象，仅语音回复' });
  }

  // 流畅模式：未要求现场对口型（且缓存未命中）→ 只回语音，不烧 EMO、不卡顿。
  // 对口型视频请在设置里「预生成」，或开启「对话时生成对口型」开关。
  if (!lipsync) {
    return res.json({ audioUrl, videoError: '流畅模式：仅语音（对口型可在设置预生成或开启对话对口型）' });
  }

  // Step 2: emoGen → 对口型视频（失败则降级：仍返回 audioUrl，前端只播音频 + 静态图，不卡死）
  try {
    console.log('[RealHuman/speak] 调用 emoGen...');
    const videoUrl = await emoGen(rhFigure.imageUrl, audioUrl, {
      face_bbox: rhFigure.faceBbox,
      ext_bbox: rhFigure.extBbox,
    });
    console.log('[RealHuman/speak] 视频 URL:', videoUrl);
    // 下载视频到本地（持久、不过期）并记入话术库：存原文 + 句向量，之后对话说到意思相近的话直接复用
    let outVideo = videoUrl;
    try {
      outVideo = await downloadVideo(videoUrl, cacheKey);
      const embedding = await getEmbedding(text.trim());   // Ollama 未就绪时为 null，仅失去语义匹配能力
      speakCache[cacheKey] = { path: outVideo, text: text.trim(), voice: usedVoice, figVer, embedding };
      writeFileSync(SPEAK_CACHE_FILE, JSON.stringify(speakCache));
    } catch (e) {
      console.warn('[RealHuman/speak] 视频下载缓存失败，回退用临时 URL:', e.message);
    }
    res.json({ videoUrl: outVideo, audioUrl });
  } catch (err) {
    console.error('[RealHuman/speak] emoGen 失败（降级播音频）:', err.message);
    res.json({ audioUrl, videoError: err.message });
  }
});

// ── 健康检查端点 ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  let currentModel;
  if (config.provider === 'gateway') currentModel = config.gateway.model;
  else if (config.provider === 'dashscope') currentModel = config.dashscope.model;
  else currentModel = config.ollama.model;

  res.json({
    status: 'ok',
    provider: config.provider,
    model: currentModel,
    tts: {
      enabled: config.tts.enabled,
      provider: config.tts.provider,
      voice: config.tts.voice,
    },
    asr: {
      enabled: config.asr.enabled,
      provider: config.asr.provider,
    },
    memory: {
      enabled: config.memory.enabled,
    },
    // 阶段 5：唤醒词 + 语音打断
    bargeIn: {
      enabled: config.bargeIn.enabled,
    },
    wakeWord: {
      enabled: config.wakeWord.enabled,
      words: config.wakeWord.words,
    },
    // 阶段 6：形象 provider
    avatar: {
      provider: config.avatar.provider,
      realHumanConfigured: !!config.avatar.realHumanServiceUrl,
    },
  });
});

// ── 启动服务 ─────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n[Server] 数字分身助手已启动`);
  console.log(`[Server] 打开浏览器访问: http://localhost:${config.port}`);
  console.log(`[Server] 按 Ctrl+C 停止服务\n`);
});
