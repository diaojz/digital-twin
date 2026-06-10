/**
 * realhuman/providers/seedance.js
 *
 * 视频 provider：字节 Seedance 2.0（火山方舟 ARK 平台，Bearer key 鉴权）
 *
 * 链路：人物图片 + 语音音频 → 多模态参考生成「对口型说话视频」。
 * ARK v3 API 原生支持音频输入：content 数组里放
 *   text + image_url(role=reference_image) + audio_url(role=reference_audio)，
 * 配 generate_audio:true，官方宣称音素级对口型。
 *
 * 流程（全部封装在 generateVideo 内）：
 *   POST /api/v3/contents/generations/tasks 创建任务（拿 cgt- 开头的 id）
 *   → GET 同路径/{id} 轮询（间隔 5s、上限 90 次，视频生成实测 1~5 分钟）
 *   → status=succeeded 后取 content.video_url（带签名临时 URL，仅 24h 有效，
 *     调用方 server 会立即下载到 public/avatars/videos/ 入话术库缓存）。
 *
 * 与 EMO 的两点关键差异：
 *   1. 图片不用先传 OSS——直接 base64 data URI 塞进请求体（请求体上限 64MB，照片绰绰有余）；
 *      所以 prepareFigure 无事可做，形象也不存在「48h 过期刷新」问题。
 *   2. duration 必须显式给整数（4~15 秒），音频单段官方限 2~15 秒——
 *      时长优先实测音频（下载 MP3 按比特率估算），失败回退字数估算；
 *      超 15 秒不报错，夹紧到 15 秒生成（劣化不阻塞，与 emo/omnihuman 语义对齐）。
 *
 * 自包含纪律：本文件零 import 其他 provider / api.js，工具函数允许少量重复。
 */

const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const TASKS_URL = `${ARK_BASE}/contents/generations/tasks`;

// 模型 id 可用 SEEDANCE_MODEL 覆盖（如换快速版 doubao-seedance-2-0-fast-260128）
const DEFAULT_MODEL = 'doubao-seedance-2-0-260128';

// 视频生成慢（实测 1~5 分钟），轮询间隔 5s、上限 90 次 = 最多等 7.5 分钟
const POLL_INTERVAL = 5000; // ms
const MAX_POLL = 90;

// Seedance 2.0 单任务时长 4~15 秒（更长需「延长视频」续生成，本项目不做）；
// 音频参考官方限单段 2~15 秒。CosyVoice 中文语速约 4 字/秒，用于实测失败时的回退估算。
const MIN_DURATION = 4;
const MAX_DURATION = 15;
const CHARS_PER_SECOND = 4;

// 探测音频真实时长时的下载超时（音频是几百 KB 级 MP3，10s 足够）
const AUDIO_PROBE_TIMEOUT = 10000; // ms

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function authHeaders() {
  const key = process.env.ARK_API_KEY;
  if (!key) {
    throw new Error('字节 Seedance 2.0 未配置：缺 ARK_API_KEY，开通步骤见 README『三路视频 provider』');
  }
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 按文本长度估算音频时长（秒，未夹紧）——已知近似项：
 * 真正驱动视频的是上游 CosyVoice MP3，实际时长受语速参数与标点停顿影响，
 * 字数估算可能偏短（视频提前结束截断尾音）或偏长（尾部静默）。
 * 因此仅作为 probeMp3DurationSec 探测失败时的回退。
 * @param {string} text
 * @returns {number} 估算秒数（含 1 秒余量盖住语速波动）
 */
function estimateSecondsByText(text) {
  const len = (text || '').trim().length;
  if (!len) return 8; // 无文本可估时取中间值（正常 speak 链路一定有 text）
  return Math.ceil(len / CHARS_PER_SECOND) + 1;
}

/**
 * 尽力探测 MP3 真实时长（秒）：下载音频 → 跳过 ID3v2 → 找首个 MPEG 帧头读比特率
 * → 按 CBR 算 时长 ≈ 音频字节数 × 8 / 比特率（CosyVoice 产物为 CBR MP3，误差通常 < 1 秒）。
 * 任何一步失败返回 null（调用方回退字数估算），绝不抛错阻塞主链路。
 * @param {string} audioUrl 公网 MP3 地址
 * @returns {Promise<number|null>} 秒数或 null
 */
async function probeMp3DurationSec(audioUrl) {
  try {
    const resp = await fetch(audioUrl, { signal: AbortSignal.timeout(AUDIO_PROBE_TIMEOUT) });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 128) return null;

    // 跳过 ID3v2 标签（"ID3" + 版本 2B + 标志 1B + synchsafe 长度 4B）
    let offset = 0;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const tagSize = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
                      ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      offset = 10 + tagSize;
    }

    // 在前 8KB 内找帧同步字（0xFFEx），读 MPEG 版本与比特率索引
    const scanEnd = Math.min(buf.length - 4, offset + 8192);
    for (let i = offset; i <= scanEnd; i++) {
      if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
      const versionBits = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
      const layerBits = (buf[i + 1] >> 1) & 0x03;   // 1=Layer III
      if (versionBits === 1 || layerBits !== 1) continue;
      const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
      // Layer III 比特率表（kbps）：MPEG1 与 MPEG2/2.5 两套
      const table = versionBits === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
      const kbps = table[bitrateIdx];
      if (!kbps) return null; // free/bad 比特率不强算
      return ((buf.length - i) * 8) / (kbps * 1000);
    }
    return null;
  } catch (e) {
    console.warn(`[Seedance] 探测音频时长失败（将回退字数估算）: ${e.message}`);
    return null;
  }
}

/**
 * 决定任务 duration（4~15 的整数）：优先实测音频时长，失败回退字数估算；
 * 超过 15 秒上限不再抛错，而是夹紧到 15 秒并告警——长回复至少能出 15 秒视频，
 * 与 emo/omnihuman「超长仅效果劣化、不阻塞」的语义对齐（尾音可能被截断/口型对不齐）。
 * @param {string} text
 * @param {string} audioUrl
 * @returns {Promise<number>}
 */
async function resolveDuration(text, audioUrl) {
  let estSec = await probeMp3DurationSec(audioUrl);
  let source = 'MP3 实测';
  if (estSec == null) {
    estSec = estimateSecondsByText(text);
    source = '字数估算';
  }

  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.ceil(estSec)));
  if (estSec > MAX_DURATION) {
    console.warn(
      `[Seedance] 语音约 ${Math.ceil(estSec)} 秒（${source}）超过单条上限 ${MAX_DURATION} 秒，` +
      `按 ${MAX_DURATION} 秒生成：尾部语音可能被截断、口型可能劣化；` +
      `若 API 拒收超长参考音频，会在创建/轮询阶段报错并走既有「只播音频」降级`
    );
  } else {
    console.log(`[Seedance] duration=${duration}s（${source}约 ${estSec.toFixed(1)} 秒）`);
  }
  return duration;
}

/**
 * 创建视频生成任务，返回任务 id（cgt- 开头）
 * @param {object} payload
 * @returns {Promise<string>} taskId
 */
async function createTask(payload) {
  const resp = await fetch(TASKS_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    // 最常见可执行原因单独点名，省得用户对着裸 HTTP 码发呆
    let hint = '';
    if (resp.status === 401 || resp.status === 403) {
      hint = '（ARK_API_KEY 无效或无权限：去火山方舟控制台「API Key 管理」核对）';
    } else if (/ModelNotOpen|not.*activat|未开通/i.test(body)) {
      hint = `（模型未开通：去火山方舟控制台「开通管理」开通 ${payload.model}）`;
    }
    throw new Error(`Seedance 创建任务失败 HTTP ${resp.status}${hint}: ${body}`);
  }

  const data = await resp.json();
  const taskId = data?.id;
  if (!taskId) {
    throw new Error(`Seedance 创建任务未返回 id: ${JSON.stringify(data)}`);
  }
  return taskId;
}

/**
 * 轮询任务直到终态，成功返回视频 URL。
 * 状态机：queued / running → 继续等；succeeded → 取 content.video_url；
 * 其余（failed / cancelled / expired / content_filter…）一律按终态失败处理。
 * @param {string} taskId
 * @returns {Promise<string>} videoUrl（24h 有效，调用方需立即下载缓存）
 */
async function pollVideoTask(taskId) {
  const url = `${TASKS_URL}/${taskId}`;

  for (let i = 0; i < MAX_POLL; i++) {
    await sleep(POLL_INTERVAL);

    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Seedance 轮询任务失败 HTTP ${resp.status}: ${body}`);
    }

    const data = await resp.json();
    const status = data?.status;

    if (status === 'queued' || status === 'running') {
      console.log(`[Seedance] 任务 ${taskId} 状态=${status}，第 ${i + 1}/${MAX_POLL} 次轮询`);
      continue;
    }

    if (status === 'succeeded') {
      const videoUrl = data?.content?.video_url;
      if (!videoUrl) {
        throw new Error(`Seedance 任务成功但未返回视频 URL: ${JSON.stringify(data)}`);
      }
      return videoUrl;
    }

    // 非 queued/running/succeeded 一律视作终态失败（failed/cancelled/expired/content_filter）
    const err = data?.error;
    const reason = err ? `${err.code || ''} ${err.message || ''}`.trim() : JSON.stringify(data);
    let hint = '';
    if (status === 'content_filter' || /filter|sensitive|审核/i.test(reason)) {
      hint = '（疑似触发内容审核：Seedance 对真人人脸有合规限制，可换更清晰的正面照、或改用 emo provider 试试）';
    }
    throw new Error(`Seedance 任务终态 ${status}${hint}: ${reason}`);
  }

  throw new Error(
    `Seedance 任务 ${taskId} 超时（等待超过 ${(MAX_POLL * POLL_INTERVAL) / 1000}s），` +
    '可稍后重试或换快速版（.env 设 SEEDANCE_MODEL=doubao-seedance-2-0-fast-260128）'
  );
}

// ── Provider 对象（契约 §1） ─────────────────────────────────

export default {
  id: 'seedance',
  displayName: '字节 Seedance 2.0',

  /**
   * 配置自检（同步、零网络请求）。
   * SEEDANCE_MODEL 有默认值（doubao-seedance-2-0-260128），不算缺失项。
   * @returns {{ ready: boolean, missing: string[] }}
   */
  configStatus() {
    const missing = [];
    if (!process.env.ARK_API_KEY) missing.push('ARK_API_KEY');
    return { ready: missing.length === 0, missing };
  },

  /**
   * 形象预处理：Seedance 无需任何预处理——
   * 图片每次随 generateVideo 请求以 base64 data URI 内联提交（无 OSS 上传、无人脸检测前置、
   * 无 URL 过期问题），所以这里只返回最小 meta 占位，调用方照常持久化即可。
   * @param {{ imageBuffer: Buffer, mime: string, ratio: '3:4'|'1:1' }} input
   * @returns {Promise<{ meta: object }>}
   */
  async prepareFigure() {
    return { meta: {} };
  },

  /**
   * 对口型视频生成：人物图（base64 内联）+ 参考音频（CosyVoice 公网 MP3 直接引用）
   * → 创建异步任务 → 轮询 → 返回视频 URL。
   *
   * @param {{ imageBuffer: Buffer|null, mime: string, meta: object, audioUrl: string, text: string }} input
   *   - audioUrl 是 CosyVoice 公网 MP3（24h 有效），Seedance 的 audio_url 接受公网 URL，
   *     请求体里无需转 base64；MP3 在其支持格式（wav/mp3）内。
   *     （提交前会额外下载一次该 MP3 用于探测真实时长定 duration，失败自动回退字数估算。）
   *   - meta 为空对象（见 prepareFigure），本 provider 不依赖它。
   * @returns {Promise<{ videoUrl: string }>}
   */
  async generateVideo({ imageBuffer, mime, audioUrl, text }) {
    if (!imageBuffer || !imageBuffer.length) {
      throw new Error('Seedance 缺少形象图片：请到「设置 → 形象图片」重新生成或上传照片');
    }
    if (!audioUrl) {
      throw new Error('Seedance 缺少参考音频 URL：上游 TTS（CosyVoice）未产出音频');
    }

    // duration：优先实测音频时长，失败回退字数估算；超长夹紧到 15 秒并告警（不抛错）
    const duration = await resolveDuration(text, audioUrl);

    // 图片以 base64 data URI 内联（格式名须小写，如 data:image/jpeg;base64,xxx）
    const imageDataUri = `data:${(mime || 'image/jpeg').toLowerCase()};base64,${imageBuffer.toString('base64')}`;

    // ⚠️ 对口型场景图片必须走 role=reference_image「多模态参考」，不能用 first_frame
    //（first_frame 图生视频场景与音频参考互斥）；想让人物图就是第一帧，靠 prompt 写「首帧为图片1」。
    const payload = {
      model: process.env.SEEDANCE_MODEL || DEFAULT_MODEL,
      content: [
        {
          type: 'text',
          text: '首帧为图片1。图片1中的人物面向镜头自然说话，使用音频1作为人物台词语音，' +
                '口型与音频1完全同步，表情自然，轻微点头，近景固定机位，背景保持不变。',
        },
        {
          type: 'image_url',
          image_url: { url: imageDataUri },
          role: 'reference_image',
        },
        {
          type: 'audio_url',
          audio_url: { url: audioUrl },
          role: 'reference_audio',
        },
      ],
      generate_audio: true,
      resolution: '720p',
      ratio: 'adaptive',
      duration,
      watermark: false,
    };

    console.log(`[Seedance] 提交对口型任务（model=${payload.model}, duration=${duration}s）...`);
    const taskId = await createTask(payload);
    console.log(`[Seedance] 任务已创建 ${taskId}，开始轮询...`);

    const videoUrl = await pollVideoTask(taskId);
    return { videoUrl };
  },
};
