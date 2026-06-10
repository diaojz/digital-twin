/**
 * realhuman/providers/emo.js
 *
 * 视频 provider：阿里 EMO（DashScope「悦动人像」，emo-detect-v1 + emo-v1）
 *
 * 对外暴露两层东西：
 *   1. default export —— 契约 §1 的 provider 对象（configStatus / prepareFigure / generateVideo）
 *   2. 具名导出 genFigure / emoDetect / emoGen —— EMO 系底层函数，由 realhuman/api.js
 *      re-export 保持旧 import 不炸（文生图 genFigure 属「形象来源」，三路 provider 共用）
 *
 * uploadFile / pollTask 从 ../api.js 引入：EMO 本来就属 DashScope 系，不算跨 provider 泄漏。
 */

import { uploadFile, pollTask } from '../api.js';

const DASH_BASE = 'https://dashscope.aliyuncs.com';
// oss:// 临时存储 URL 官方有效期 48h，留 1h 余量提前刷新
const OSS_URL_TTL_MS = 47 * 60 * 60 * 1000;
// wanx 文生图公网 URL 官方有效期仅 24h（比 oss 还短），同样留 1h 余量
const HTTP_URL_TTL_MS = 23 * 60 * 60 * 1000;

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

// ── 人脸检测（emo-detect-v1 同步） ───────────────────────────

/**
 * 检测图片中的人脸，返回 bbox 信息
 * @param {string} imageUrl  公网图片 URL（或 oss:// 临时存储 URL）
 * @param {string} [ratio='3:4']
 * @returns {Promise<{check_pass:boolean, face_bbox:number[], ext_bbox:number[]}>}
 */
export async function emoDetect(imageUrl, ratio = '3:4') {
  // ⚠️ emo-detect-v1 是「同步」接口：直接返回 bbox，不要加 X-DashScope-Async，
  //    否则报 403 AccessDenied "current user api does not support asynchronous calls"。
  const url = `${DASH_BASE}/api/v1/services/aigc/image2video/face-detect`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), ...ossResolveHeaders(imageUrl) },
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
  const output = data?.output;
  if (!output) {
    throw new Error(`emoDetect 响应格式异常: ${JSON.stringify(data)}`);
  }
  return {
    check_pass: output.check_pass ?? false,
    face_bbox: output.face_bbox ?? [],
    ext_bbox: output.ext_bbox ?? [],
  };
}

// ── 对口型视频生成（emo-v1 异步） ────────────────────────────

/**
 * 生成对口型视频
 * @param {string} imageUrl  人物图片公网 URL（或 oss:// 临时存储 URL）
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
      ...ossResolveHeaders(imageUrl),
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
  // 视频 URL 在 output.results.video_url（不是 output.video_url）
  const videoUrl = output?.results?.video_url;
  if (!videoUrl) {
    throw new Error(`emoGen 轮询结果无视频 URL: ${JSON.stringify(output)}`);
  }
  return videoUrl;
}

// ── Provider 对象（契约 §1） ─────────────────────────────────

export default {
  id: 'emo',
  displayName: '阿里 EMO',

  /**
   * 配置自检（同步、零网络请求）
   * @returns {{ ready: boolean, missing: string[] }}
   */
  configStatus() {
    const missing = [];
    if (!process.env.DASHSCOPE_API_KEY) missing.push('DASHSCOPE_API_KEY');
    return { ready: missing.length === 0, missing };
  },

  /**
   * 形象预处理：本地图 → DashScope 临时存储（oss:// URL）→ emo-detect-v1 人脸检测。
   *
   * 上传绑定 emo-v1：官方文档说"文件与上传时指定的模型绑定"，但实测（2026-06）
   * 绑定 emo-v1 的文件 emo-detect-v1 也能用——只传一份，跨境上传慢，省一半时间。
   *
   * 检测失败 ≠ 整体失败：降级为「仅静态形象、无对口型坐标」
   * （meta.checkPass=false + meta.detectError），由调用方决定降级展示。
   * 真正失败（上传/鉴权）：throw Error。
   *
   * @param {{ imageBuffer: Buffer, mime: string, ratio: '3:4'|'1:1' }} input
   * @returns {Promise<{ meta: object }>}
   */
  async prepareFigure({ imageBuffer, mime, ratio = '3:4' }) {
    // Step 1: 上传临时存储（oss:// 仅 48h 有效，过期由 generateVideo 自动重传刷新）
    const imageUrl = await uploadFile(imageBuffer, 'figure.jpg', 'emo-v1');

    // Step 2: 人脸检测（降级不阻塞——EMO 未开通时也能展示写实形象 + 语音对话）
    const meta = { imageUrl, faceBbox: [], extBbox: [], checkPass: false, uploadedAt: Date.now() };
    try {
      const bbox = await emoDetect(imageUrl, ratio);
      meta.faceBbox = bbox.face_bbox || [];
      meta.extBbox = bbox.ext_bbox || [];
      meta.checkPass = bbox.check_pass || false;
      if (!meta.checkPass) meta.detectError = '人脸检测未通过：请换一张单人、正面、五官清晰的照片';
    } catch (e) {
      // 最常见：EMO（悦动人像）服务未开通 → 403。形象图仍可用，只是暂无对口型坐标。
      // retryable=true：这是「检测尝试本身异常」（未开通/网络抖动/服务端错误），不是确定性的
      // 「人脸检查未通过」——调用方据此在下次 speak 时重新 prepare 自动重试（如开通服务后即自动解锁），
      // 而不是把瞬态失败永久固化成「只播音频」。确定性未通过（上面 check_pass=false 分支）不带此标记。
      meta.detectError = e.message;
      meta.retryable = true;
      console.warn('[EMO/prepareFigure] emoDetect 失败（降级为仅静态形象）:', e.message);
    }
    return { meta };
  },

  /**
   * 对口型视频生成：形象 URL 过期自动重传刷新（oss:// 48h / wanx 公网 24h）+ emo-v1。
   *
   * @param {{ imageBuffer: Buffer|null, mime: string, meta: object, audioUrl: string, text: string }} input
   *   meta 可能被原地更新（imageUrl/uploadedAt 刷新），调用方负责在调用后持久化。
   * @returns {Promise<{ videoUrl: string }>}
   */
  async generateVideo({ imageBuffer, meta, audioUrl }) {
    // 形象 URL 都有时效：oss:// 临时存储 48h，wanx 文生图公网 URL 仅 24h（更短）。
    // 快过期就用本地原图重传成 oss://（bbox 是像素坐标、图没变，所以不用重新检测）。
    if (meta.imageUrl) {
      const ttl = meta.imageUrl.startsWith('oss://') ? OSS_URL_TTL_MS : HTTP_URL_TTL_MS;
      if (Date.now() - (meta.uploadedAt || 0) > ttl) {
        console.log('[EMO/generateVideo] 形象图片 URL 已/将过期，重新上传刷新...');
        if (!imageBuffer) {
          throw new Error('形象图片 URL 已过期且本地原图丢失，无法刷新，请到「设置 → 形象图片」重新生成或上传照片');
        }
        meta.imageUrl = await uploadFile(imageBuffer, 'figure.jpg', 'emo-v1');
        meta.uploadedAt = Date.now();   // 原地更新 meta，由调用方持久化
      }
    }

    const videoUrl = await emoGen(meta.imageUrl, audioUrl, {
      face_bbox: meta.faceBbox,
      ext_bbox: meta.extBbox,
    });
    return { videoUrl };
  },
};
