/**
 * realhuman/api.js
 *
 * 阿里云 DashScope 能力封装：
 *   - chatStream     qwen3-max 流式对话（SSE）
 *   - tts            cosyvoice-v2 文字转语音
 *   - asr            qwen3-asr-flash 语音识别
 *   - uploadFile     本地文件 → DashScope 临时存储（oss:// URL，48h 有效）
 *   - pollTask       内部通用轮询（间隔 3s，最多 60 次）
 *
 * EMO 专属函数（genFigure / emoDetect / emoGen 及 oss 解析头逻辑）已下沉到
 * providers/emo.js，文件末尾 re-export 保持旧 import 不炸。
 *
 * 注意：所有鉴权从 process.env.DASHSCOPE_API_KEY 读取，
 *       该变量由 server.js 启动时解析 .env 注入，此模块无需再读 .env。
 */

const DASH_BASE = 'https://dashscope.aliyuncs.com';
const MAX_POLL = 60;       // 轮询上限（60 次 × 3s = 最多等 3 分钟）
const POLL_INTERVAL = 3000; // ms

// ── 工具函数 ─────────────────────────────────────────────────

function authHeaders() {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error('DASHSCOPE_API_KEY 未配置，请在 .env 文件中设置');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 轮询异步任务，直到 SUCCEEDED 或 FAILED
 * @param {string} taskId
 * @returns {Promise<object>} 任务 output 字段
 */
export async function pollTask(taskId) {
  const url = `${DASH_BASE}/api/v1/tasks/${taskId}`;

  for (let i = 0; i < MAX_POLL; i++) {
    await sleep(POLL_INTERVAL);

    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`轮询任务失败 HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const status = data?.output?.task_status;

    if (status === 'SUCCEEDED') {
      return data.output;
    }
    if (status === 'FAILED') {
      const msg = data?.output?.message || data?.message || JSON.stringify(data);
      throw new Error(`任务失败: ${msg}`);
    }
    // PENDING / RUNNING → 继续等
    console.log(`[pollTask] ${taskId} 状态=${status}，第 ${i + 1}/${MAX_POLL} 次轮询`);
  }

  throw new Error(`任务 ${taskId} 超时（等待超过 ${(MAX_POLL * POLL_INTERVAL) / 1000}s）`);
}

// ── 对话（qwen3-max 流式 SSE） ────────────────────────────────

/**
 * 调用 qwen3-max 流式接口，返回 Node.js ReadableStream（SSE 透传）
 * @param {Array<{role:string,content:string}>} messages
 * @param {string} [systemPrompt]
 * @returns {Promise<ReadableStream>} 原始 SSE body 流
 */
export async function chatStream(messages, systemPrompt) {
  const url = `${DASH_BASE}/compatible-mode/v1/chat/completions`;

  const finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      model: 'qwen3-max',
      messages: finalMessages,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`chatStream HTTP ${resp.status}: ${body}`);
  }

  return resp.body;
}

// ── TTS（cosyvoice-v2） ───────────────────────────────────────

/**
 * 文字转语音
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.voice='longwan_v2']  龙婉(温柔女声)/longcheng_v2/longhua_v2
 * @param {number} [opts.rate=1.0]   语速 0.5~2
 * @param {number} [opts.pitch=1.0]  音调 0.5~2
 * @param {number} [opts.volume=50]  音量 0~100
 * @returns {Promise<string>} 公网 MP3 URL（有效期 24h）
 */
export async function tts(text, { voice = 'longwan_v2', rate = 1.0, pitch = 1.0, volume = 50 } = {}) {
  // CosyVoice 语音合成走专用 SpeechSynthesizer 端点；
  // 注意：format/sample_rate/rate/pitch/volume 都放在 input 里（不是 parameters），否则报 "url error"
  const url = `${DASH_BASE}/api/v1/services/audio/tts/SpeechSynthesizer`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'cosyvoice-v2',
      input: {
        text,
        voice,
        format: 'mp3',
        sample_rate: 24000,
        rate,
        pitch,
        volume,
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`TTS HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const audioUrl = data?.output?.audio?.url;
  if (!audioUrl) {
    throw new Error(`TTS 响应格式异常: ${JSON.stringify(data)}`);
  }
  return audioUrl;
}

// ── ASR 语音识别（qwen3-asr-flash 同步） ─────────────────────

/**
 * 录音转文字：唯一支持同步 HTTP 调用的百炼 ASR 模型。
 * 实测浏览器 MediaRecorder 的 webm/opus（Chrome）和 mp4/aac（Safari）免转码直通。
 * 限制：单段 ≤ 5 分钟、≤ 10MB（base64 后）；计费 0.00022 元/秒，送 10 小时（90 天）。
 *
 * @param {Buffer} audioBuffer  音频文件内容
 * @param {string} [mime='audio/webm']  音频 MIME
 * @returns {Promise<string>} 识别出的文字
 */
export async function asr(audioBuffer, mime = 'audio/webm') {
  const url = `${DASH_BASE}/api/v1/services/aigc/multimodal-generation/generation`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    signal: AbortSignal.timeout(60000),
    body: JSON.stringify({
      model: 'qwen3-asr-flash',
      input: {
        messages: [
          // system 热词：纠正同音字（否则「小忆」常被识别成「小易/小依」）
          { role: 'system', content: [{ text: '这是用户对数字人助手「小忆」说的话，人名「小忆」要写作忆。' }] },
          { role: 'user', content: [{ audio: `data:${mime};base64,${audioBuffer.toString('base64')}` }] },
        ],
      },
      // enable_itn：把"三点半"规整成"3点半"，聊天输入体验更好
      parameters: { asr_options: { language: 'zh', enable_itn: true } },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ASR HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const text = data?.output?.choices?.[0]?.message?.content?.[0]?.text;
  if (text === undefined) {
    throw new Error(`ASR 响应格式异常: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return text;
}

// ── 本地文件上传（DashScope 临时存储） ───────────────────────

/**
 * 把本地文件（Buffer）上传到 DashScope 临时存储，换取模型可用的 oss:// URL。
 * 官方链路：getPolicy 拿上传凭证 → 表单直传 OSS → oss://<key>。
 * 调模型时需带请求头 X-DashScope-OssResourceResolve: enable（emoDetect/emoGen 已自动处理）。
 *
 * ⚠️ 两个硬性约束（来自官方文档）：
 *   1. 上传时的 model 必须和后续调用的模型一致（emo-detect-v1 / emo-v1 要各传一次）
 *   2. oss:// URL 仅 48 小时有效，过期需重新上传（server.js 里有自动刷新）
 *
 * @param {Buffer} buffer    文件内容
 * @param {string} filename  文件名（决定 OSS key 的扩展名）
 * @param {string} model     后续要用这个文件调用的模型名
 * @returns {Promise<string>} oss:// 形式的 URL
 */
export async function uploadFile(buffer, filename, model) {
  // Step 1: 获取上传凭证（凭证约 5 分钟过期，每次现取）
  const polUrl = `${DASH_BASE}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
  const polResp = await fetch(polUrl, { headers: authHeaders(), signal: AbortSignal.timeout(15000) });
  if (!polResp.ok) {
    const body = await polResp.text();
    throw new Error(`uploadFile 获取上传凭证失败 HTTP ${polResp.status}: ${body}`);
  }
  const pol = (await polResp.json())?.data;
  const need = ['policy', 'signature', 'oss_access_key_id', 'upload_host', 'upload_dir', 'x_oss_object_acl', 'x_oss_forbid_overwrite'];
  if (!pol || need.some(k => pol[k] === undefined)) {
    throw new Error('uploadFile 上传凭证响应缺字段（DashScope 接口可能已变更）');
  }

  // Step 2: 表单直传 OSS。字段顺序有讲究：file 必须是最后一个表单域
  const key = `${pol.upload_dir}/${Date.now()}-${filename}`;
  const form = new FormData();
  form.append('OSSAccessKeyId', pol.oss_access_key_id);
  form.append('policy', pol.policy);
  form.append('Signature', pol.signature);
  form.append('key', key);
  form.append('x-oss-object-acl', pol.x_oss_object_acl);
  form.append('x-oss-forbid-overwrite', pol.x_oss_forbid_overwrite);
  form.append('success_action_status', '200');
  form.append('file', new Blob([buffer]), filename);

  // 海外服务器→北京 OSS 跨境上传可能很慢（实测 200KB 约 10-25s），超时给足但别无限挂
  const upResp = await fetch(pol.upload_host, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  if (!upResp.ok) {
    const body = await upResp.text();
    throw new Error(`uploadFile OSS 直传失败 HTTP ${upResp.status}: ${body}`);
  }

  return `oss://${key}`;
}

// ── EMO 专属函数 re-export ───────────────────────────────────
// genFigure/emoDetect/emoGen 已下沉到 providers/emo.js（视频 provider 架构），
// 这里 re-export 保持旧 import（server.js / 脚本）不炸。
// 注：与 providers/emo.js 构成循环引用，但双方都只在「调用时」用到对方的函数
//（uploadFile/pollTask 是函数声明、有提升），ESM 活绑定下安全。
export { genFigure, emoDetect, emoGen } from './providers/emo.js';
