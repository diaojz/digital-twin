/**
 * realhuman/api.js
 *
 * 阿里云 DashScope 能力封装：
 *   - chatStream     qwen3-max 流式对话（SSE）
 *   - tts            cosyvoice-v2 文字转语音
 *   - genFigure      wanx2.1-t2i-turbo 文生图
 *   - emoDetect      emo-detect-v1 人脸检测
 *   - emoGen         emo-v1 对口型视频生成
 *   - pollTask       内部通用轮询（间隔 3s，最多 60 次）
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
  const url = `${DASH_BASE}/api/v1/services/aigc/multimodal-generation/generation`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'cosyvoice-v2',
      input: { text, voice },
      parameters: {
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

// ── 文生图（wanx2.1-t2i-turbo 异步） ─────────────────────────

/**
 * 文生图，返回图片公网 URL（有效期 24h）
 * @param {string} prompt
 * @param {string} [size='720*1280']
 * @returns {Promise<string>} 图片 URL
 */
export async function genFigure(prompt, size = '720*1280') {
  const url = `${DASH_BASE}/api/v1/services/aigc/text2image/image-synthesis`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'wanx2.1-t2i-turbo',
      input: { prompt },
      parameters: { size, n: 1 },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`genFigure HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error(`genFigure 未获得 task_id: ${JSON.stringify(data)}`);
  }

  const output = await pollTask(taskId);
  const imageUrl = output?.results?.[0]?.url;
  if (!imageUrl) {
    throw new Error(`genFigure 轮询结果无图片 URL: ${JSON.stringify(output)}`);
  }
  return imageUrl;
}

// ── 人脸检测（emo-detect-v1 异步） ───────────────────────────

/**
 * 检测图片中的人脸，返回 bbox 信息
 * @param {string} imageUrl  公网图片 URL
 * @param {string} [ratio='3:4']
 * @returns {Promise<{check_pass:boolean, face_bbox:number[], ext_bbox:number[]}>}
 */
export async function emoDetect(imageUrl, ratio = '3:4') {
  const url = `${DASH_BASE}/api/v1/services/aigc/image2video/face-detect`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'emo-detect-v1',
      input: { image_url: imageUrl },
      parameters: { ratio },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`emoDetect HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error(`emoDetect 未获得 task_id: ${JSON.stringify(data)}`);
  }

  const output = await pollTask(taskId);
  return {
    check_pass: output?.check_pass ?? false,
    face_bbox: output?.face_bbox ?? [],
    ext_bbox: output?.ext_bbox ?? [],
  };
}

// ── 对口型视频生成（emo-v1 异步） ────────────────────────────

/**
 * 生成对口型视频
 * @param {string} imageUrl  人物图片公网 URL
 * @param {string} audioUrl  音频公网 URL（MP3）
 * @param {{face_bbox:number[], ext_bbox:number[]}} bbox  emoDetect 返回的 bbox
 * @returns {Promise<string>} 视频公网 URL（MP4）
 */
export async function emoGen(imageUrl, audioUrl, bbox) {
  const url = `${DASH_BASE}/api/v1/services/aigc/image2video/video-synthesis/`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'emo-v1',
      input: {
        image_url: imageUrl,
        audio_url: audioUrl,
        face_bbox: bbox.face_bbox,
        ext_bbox: bbox.ext_bbox,
      },
      parameters: { style_level: 'normal' },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`emoGen HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error(`emoGen 未获得 task_id: ${JSON.stringify(data)}`);
  }

  const output = await pollTask(taskId);
  const videoUrl = output?.video_url;
  if (!videoUrl) {
    throw new Error(`emoGen 轮询结果无视频 URL: ${JSON.stringify(output)}`);
  }
  return videoUrl;
}
