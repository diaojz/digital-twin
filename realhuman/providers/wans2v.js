/**
 * realhuman/providers/wans2v.js
 *
 * 视频 provider：阿里 万相全身（DashScope「数字人 wan2.2-s2v」，wan2.2-s2v-detect + wan2.2-s2v）
 *
 * 和 EMO 的核心差异（同一个 DASHSCOPE_API_KEY，无需新 key）：
 *   - 输入支持「肖像 / 半身 / 全身照」，不裁画幅、不需要 bbox 坐标——生成只要原图 + 音频
 *   - 驱动范围是口型 + 表情 + 肢体/手部动作（EMO 只动嘴和头）
 *   - 计费 480P 0.5 元/秒 / 720P 0.9 元/秒（EMO 0.08~0.16），免费额度 100 秒（90 天）
 *   - 官方标注单条耗时约 5-10 分钟（实测短句 1 分钟出头），轮询预算放大到 20 分钟
 *   - ⚠️ 音频硬限制 <20 秒（约 70 字），generateVideo 里按字数预拦截，不白烧任务费
 *
 * 工程事实（官方文档 wan-s2v-api / wan-s2v-detect-api，2026-06 实测验证）：
 *   - detect 是同步接口（与 emo-detect 同端点换 model），只返回 check_pass/humanoid，无 bbox
 *   - 生成与 emo-v1 同端点（image2video/video-synthesis）换 model，X-DashScope-Async 异步
 *   - oss:// 临时存储 + X-DashScope-OssResourceResolve 头对两个模型均可用（已实测）
 *   - 视频 URL 在 output.results.video_url，24h 有效——调用方下载落盘
 *
 * uploadFile / pollTask 从 ../api.js 引入：与 EMO 同属 DashScope 系，不算跨 provider 泄漏。
 */

import { uploadFile, pollTask } from '../api.js';

const DASH_BASE = 'https://dashscope.aliyuncs.com';
// oss:// 临时存储 URL 官方有效期 48h，留 1h 余量提前刷新
const OSS_URL_TTL_MS = 47 * 60 * 60 * 1000;
// wanx 文生图公网 URL 官方有效期仅 24h（比 oss 还短），同样留 1h 余量
const HTTP_URL_TTL_MS = 23 * 60 * 60 * 1000;

// 音频 <20 秒硬限制 → 文本预拦截阈值：CosyVoice 中文约 4 字/秒，70 字 ≈ 17.5 秒留安全余量
const MAX_TEXT_CHARS = 70;

// 小工具与 api.js 有少量重复——契约允许（provider 自包含优先，不为复用借工具）
function authHeaders() {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) throw new Error('DASHSCOPE_API_KEY 未配置，请在 .env 文件中设置');
  return {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 图片 URL 若是 oss:// 临时存储链接，调模型时要额外带解析头
 */
function ossResolveHeaders(imageUrl) {
  return imageUrl.startsWith('oss://')
    ? { 'X-DashScope-OssResourceResolve': 'enable' }
    : {};
}

// ── 图像检测（wan2.2-s2v-detect 同步） ───────────────────────

/**
 * 检测图片是否适合 wan2.2-s2v（有无人像等）。
 * 与 emoDetect 的区别：不裁画幅、不返回 bbox——生成时只要原图 URL，无需任何坐标。
 * @param {string} imageUrl  公网或 oss:// 图片 URL
 * @returns {Promise<{check_pass:boolean, humanoid:boolean}>}
 */
export async function wanS2VDetect(imageUrl) {
  const url = `${DASH_BASE}/api/v1/services/aigc/image2video/face-detect`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), ...ossResolveHeaders(imageUrl) },
    body: JSON.stringify({
      model: 'wan2.2-s2v-detect',
      input: { image_url: imageUrl },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`wanS2VDetect HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const output = data?.output;
  if (!output) {
    throw new Error(`wanS2VDetect 响应格式异常: ${JSON.stringify(data)}`);
  }
  return {
    check_pass: output.check_pass ?? false,
    humanoid: output.humanoid ?? false,
  };
}

// ── 全身数字人视频生成（wan2.2-s2v 异步） ────────────────────

/**
 * 全身照 + 音频 → 带肢体动作的数字人视频（口型/表情/动作随音频）。
 * @param {string} imageUrl  人物图片 URL（公网或 oss://）
 * @param {string} audioUrl  音频 URL（wav/mp3，<15MB，<20s）
 * @param {object} [opts]
 * @param {string} [opts.resolution='480P']  '480P' | '720P'
 * @returns {Promise<string>} 视频公网 URL（MP4，24h 有效）
 */
export async function wanS2VGen(imageUrl, audioUrl, { resolution = '480P' } = {}) {
  const url = `${DASH_BASE}/api/v1/services/aigc/image2video/video-synthesis`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      ...ossResolveHeaders(imageUrl),
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: 'wan2.2-s2v',
      input: {
        image_url: imageUrl,
        audio_url: audioUrl,
      },
      parameters: { resolution },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`wanS2VGen HTTP ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const taskId = data?.output?.task_id;
  if (!taskId) {
    throw new Error(`wanS2VGen 未获得 task_id: ${JSON.stringify(data)}`);
  }

  // 官方标注 5-10 分钟：6s × 200 次 = 最多等 20 分钟（emo 默认 3 分钟必超时）
  const output = await pollTask(taskId, { maxPoll: 200, interval: 6000 });
  const videoUrl = output?.results?.video_url;
  if (!videoUrl) {
    throw new Error(`wanS2VGen 轮询结果无视频 URL: ${JSON.stringify(output)}`);
  }
  return videoUrl;
}

// ── Provider 对象（契约 §1） ─────────────────────────────────

export default {
  id: 'wans2v',
  displayName: '阿里 万相全身',

  /**
   * 配置自检（同步、零网络请求）——和 EMO 共用同一个 DashScope key
   * @returns {{ ready: boolean, missing: string[] }}
   */
  configStatus() {
    const missing = [];
    if (!process.env.DASHSCOPE_API_KEY) missing.push('DASHSCOPE_API_KEY');
    return { ready: missing.length === 0, missing };
  },

  /**
   * 形象预处理：本地图 → DashScope 临时存储（绑定 wan2.2-s2v 的 oss:// URL）→ 图像检测。
   *
   * 检测只做「能不能用」校验（check_pass），不产出坐标——meta 里没有 bbox 是正常的。
   * 检测失败 ≠ 整体失败：降级为「仅静态形象」（meta.checkPass=false + detectError），
   * 由调用方决定降级展示；真正失败（上传/鉴权）：throw Error。
   *
   * 注：契约入参里的 ratio 是 EMO 的裁剪比例概念，wan2.2-s2v 不裁画幅、按原图比例输出，此处忽略。
   *
   * @param {{ imageBuffer: Buffer, mime: string, ratio: '3:4'|'1:1' }} input
   * @returns {Promise<{ meta: object }>}
   *   meta = { imageUrl, uploadedAt, checkPass, detectError?, retryable? }
   */
  async prepareFigure({ imageBuffer }) {
    // Step 1: 上传临时存储（绑定 wan2.2-s2v——官方要求上传与调用模型一致；
    //         实测同端点的 detect 模型也认这份文件，只传一次）
    const imageUrl = await uploadFile(imageBuffer, 'figure.jpg', 'wan2.2-s2v');
    const meta = { imageUrl, uploadedAt: Date.now(), checkPass: false };

    // Step 2: 图像检测（降级不阻塞——模型未开通时也能展示静态形象 + 语音对话）
    try {
      const det = await wanS2VDetect(imageUrl);
      meta.checkPass = det.check_pass || false;
      if (!meta.checkPass) {
        meta.detectError = '图像检测未通过：请换一张单人、人物清晰的照片（全身/半身/肖像均可）';
      }
    } catch (e) {
      // 最常见：wan2.2-s2v 模型未开通 → 403。形象图仍可用，只是暂无说话视频。
      // retryable=true：检测尝试本身异常（未开通/网络抖动），下次 speak 自动重新 prepare；
      // 确定性未通过（上面 check_pass=false 分支）不带此标记，speak 秒拦截、不重复烧钱。
      meta.detectError = e.message;
      meta.retryable = true;
      console.warn('[WanS2V/prepareFigure] 图像检测失败（降级为仅静态形象）:', e.message);
    }
    return { meta };
  },

  /**
   * 全身视频生成：文本长度预拦截 → 形象 URL 过期自动重传刷新 → wan2.2-s2v。
   *
   * @param {{ imageBuffer: Buffer|null, mime: string, meta: object, audioUrl: string, text: string }} input
   *   meta 可能被原地更新（imageUrl/uploadedAt 刷新），调用方负责在调用后持久化。
   * @returns {Promise<{ videoUrl: string }>}
   */
  async generateVideo({ imageBuffer, meta, audioUrl, text }) {
    // 音频 <20 秒硬限制：超长任务必然失败还要白等几分钟，按字数提前拦截。
    // 抛错走调用方的「降级播音频」路径，文案告诉用户怎么改。
    if (text && text.length > MAX_TEXT_CHARS) {
      throw new Error(
        `这句话太长（${text.length} 字）：万相全身模型的音频须 <20 秒（约 ${MAX_TEXT_CHARS} 字内），` +
        '请改短一点再生成，或切回「阿里 EMO」说长句'
      );
    }

    // 形象 URL 都有时效：oss:// 临时存储 48h，wanx 文生图公网 URL 仅 24h（更短）。
    // 快过期就用本地原图重传成 oss://（检测结果只看图本身、图没变，不用重新检测）。
    if (meta.imageUrl) {
      const ttl = meta.imageUrl.startsWith('oss://') ? OSS_URL_TTL_MS : HTTP_URL_TTL_MS;
      if (Date.now() - (meta.uploadedAt || 0) > ttl) {
        console.log('[WanS2V/generateVideo] 形象图片 URL 已/将过期，重新上传刷新...');
        if (!imageBuffer) {
          throw new Error('形象图片 URL 已过期且本地原图丢失，无法刷新，请到「设置 → 形象图片」重新生成或上传照片');
        }
        meta.imageUrl = await uploadFile(imageBuffer, 'figure.jpg', 'wan2.2-s2v');
        meta.uploadedAt = Date.now();   // 原地更新 meta，由调用方持久化
      }
    }

    const resolution = process.env.WANS2V_RESOLUTION === '720P' ? '720P' : '480P';
    const videoUrl = await wanS2VGen(meta.imageUrl, audioUrl, { resolution });
    return { videoUrl };
  },
};
