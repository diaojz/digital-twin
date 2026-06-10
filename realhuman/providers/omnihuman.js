/**
 * realhuman/providers/omnihuman.js
 *
 * 视频 provider：字节 OmniHuman（火山引擎「即梦AI · 数字人快速模式」，产品 85621）
 *
 * 链路（全部 POST https://visual.volcengineapi.com/?Action=...&Version=2022-08-31，
 * 鉴权是火山 V4 签名，见 ./volc-sign.js）：
 *   prepareFigure：本地图 → 免费图床中转拿公网 URL → CVSubmitTask(主体识别) → CVGetResult 轮询
 *   generateVideo：图床 URL 过期自动重传 → CVSubmitTask(图片+音频) → CVGetResult 轮询 → data.video_url
 *
 * 几个工程事实（来自官方文档 85621/1810468、1810471）：
 *   - 图片/音频都只收「公网可访问的 URL」，不收 base64；火山没有 DashScope 那种官方
 *     临时存储通道，这里用 tmpfiles.org 免费图床中转（直链 60 分钟有效，过期自动重传）。
 *     ⚠️ 待真实 key 验证：火山国内机房能否稳定拉取 tmpfiles.org（境外站点）；
 *     不行就换自己的 OSS/CDN，只需替换 uploadToTmpHost 一个函数。
 *   - 计费 1 元/秒视频、并发限额 1（第二个并行任务报 50430）、输出 480P mp4。
 *   - 生成速度 RTF≈20（10 秒音频约 200 秒），音频官方建议 <15 秒。
 *   - 任务结果保留 12 小时；video_url 仅 1 小时有效——调用方（server.js）拿到后立即下载落盘。
 *
 * 自包含纪律：不 import realhuman/api.js 或其他 provider 的任何东西。
 */

import { signVolcRequest } from './volc-sign.js';

const VERSION = '2022-08-31';

// ⚠️ 待真实 key 验证：req_key 取值来自官方文档 85621/1810469、1810471 与多份社区镜像互证，
// 但本次未实际发请求确认。注意别和 85128「克隆数字人」的 realman_avatar_creation_task 混淆。
const REQ_KEY_ROLE = 'jimeng_realman_avatar_picture_create_role_omni'; // 步骤1：主体识别
const REQ_KEY_VIDEO = 'jimeng_realman_avatar_picture_omni_v2';         // 步骤2：视频生成（核心）

// tmpfiles.org 直链官方有效期 60 分钟，留 10 分钟余量提前刷新
const TMP_URL_TTL_MS = 50 * 60 * 1000;

const CONSOLE_HINT =
  'AK/SK 在火山控制台右上角头像 →「API访问密钥」创建；服务在「即梦AI」能力页自助开通' +
  '「数字人快速模式」（https://console.volcengine.com/ai/ability/info/20012），需账号实名认证';

// 火山业务错误码 → 可执行的中文提示（官方文档 1810471 错误码表）
const CODE_HINTS = {
  50411: '输入图片未通过内容审核，请换一张照片',
  50412: '输入内容未通过审核，请更换图片/文本',
  50413: '文本含敏感词，请修改后重试',
  50429: 'QPS 超限，稍等几秒重试',
  50430: '并发超限——数字人快速模式并发限额为 1，等上一条视频生成完再试',
  50215: '输入不合法，常见原因是音频超长（官方建议 <15 秒，OmniHuman1.5 硬限制 <60 秒），请缩短这句话',
  50500: '服务端内部错误，可重试',
  50501: '服务端内部错误，可重试',
  50511: '服务端内部错误，可重试',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 本地图片 → 公网 URL（tmpfiles.org 免费图床中转）。
 * 火山只收公网 URL，且没有官方临时存储；要换图床只改这一个函数。
 * @param {Buffer} imageBuffer
 * @param {string} mime
 * @returns {Promise<string>} 公网直链（60 分钟有效）
 */
async function uploadToTmpHost(imageBuffer, mime = 'image/jpeg') {
  const ext = mime.includes('png') ? 'png' : 'jpg';
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: mime }), `figure.${ext}`);

  let resp;
  try {
    resp = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: form });
  } catch (e) {
    throw new Error(
      `字节 OmniHuman 形象图中转上传失败（tmpfiles.org 网络不通：${e.message}）。` +
      '火山只收公网图片 URL，需要图床中转；请检查本机网络/代理，或把 uploadToTmpHost 换成自己的 OSS/CDN'
    );
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`字节 OmniHuman 形象图中转上传失败（tmpfiles.org HTTP ${resp.status}）: ${body.slice(0, 200)}`);
  }
  const data = await resp.json().catch(() => null);
  const pageUrl = data?.data?.url;
  if (data?.status !== 'success' || !pageUrl) {
    throw new Error(`字节 OmniHuman 形象图中转上传响应异常: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // 返回的是预览页 URL，插入 /dl/ 才是图片字节直链（火山服务端要直接拉到图片本体）
  return pageUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
}

/**
 * 调一次火山 OpenAPI（V4 签名 + 业务码检查）。
 * 火山的成功判据是业务码 code === 10000（不是 HTTP 状态码）；失败时 data 为 null。
 * @param {string} action  'CVSubmitTask' | 'CVGetResult'
 * @param {object} body
 * @param {string} step    出错时标注是哪一步（契约 §5：错误消息必须可执行）
 * @returns {Promise<object>} 响应里的 data 字段
 */
async function volcPost(action, body, step) {
  const ak = process.env.VOLC_ACCESS_KEY_ID;
  const sk = process.env.VOLC_SECRET_ACCESS_KEY;
  if (!ak || !sk) {
    const err = new Error(`字节 OmniHuman 未配置：缺 VOLC_ACCESS_KEY_ID/VOLC_SECRET_ACCESS_KEY。${CONSOLE_HINT}`);
    err.isAuth = true; // 鉴权/配置类错误标记：契约 §1 规定鉴权失败必须 throw，不得降级吞掉
    throw err;
  }

  // body 字符串与签名用的必须是同一份，否则 400 Invalid Authorization
  const bodyString = JSON.stringify(body);
  const { url, headers } = signVolcRequest({
    accessKeyId: ak,
    secretAccessKey: sk,
    query: { Action: action, Version: VERSION },
    bodyString,
  });

  const resp = await fetch(url, { method: 'POST', headers, body: bodyString });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 走下面的 HTTP 错误分支 */ }

  if (!resp.ok || !data) {
    const isAuth = resp.status === 401 || resp.status === 403 || /Authorization/i.test(text);
    const authHint = isAuth ? `可能是 AK/SK 不正确或签名异常。${CONSOLE_HINT}` : '';
    const err = new Error(`字节 OmniHuman ${step}失败（HTTP ${resp.status}）: ${text.slice(0, 300)} ${authHint}`.trim());
    if (isAuth) err.isAuth = true; // 鉴权类错误标记，prepareFigure 据此 rethrow 而非降级
    throw err;
  }
  if (data.code !== 10000) {
    const isAuth = /Authorization|credential/i.test(data.message || '');
    const hint = CODE_HINTS[data.code]
      || (isAuth ? `可能是 AK/SK 不正确。${CONSOLE_HINT}` : `未开通服务时也会报错——${CONSOLE_HINT}`);
    const err = new Error(
      `字节 OmniHuman ${step}失败（code=${data.code}: ${data.message}）：${hint}（request_id=${data.request_id || '无'}）`
    );
    if (isAuth) err.isAuth = true;
    throw err;
  }
  return data.data;
}

// 「继续等」的进行中状态白名单——不在白名单且非终态的未知 status 一律按失败抛出，
// 避免任务以文档未覆盖的失败态结束时静默空转 10 分钟（与 seedance 的终态纪律对齐）
const POLL_PENDING_STATUSES = ['in_queue', 'processing', 'generating'];

/**
 * CVGetResult 轮询（轮询纪律参照 emo：间隔 3s，超时报错带任务 id；每轮打 status 进度日志）。
 * data.status 枚举：in_queue / processing / generating → 继续等；
 * done → 返回（成功失败都报 done，失败已在 volcPost 的 code!==10000 分支抛出）；
 * not_found / expired → 任务无效，直接报错；
 * 其余未知 status → 按终态失败抛出（req_key/状态枚举待真实 key 验证，未知态最可能撞上）。
 * @param {string} reqKey      与提交时相同的 req_key
 * @param {string} taskId
 * @param {{ maxAttempts?: number, step?: string }} [opts]
 * @returns {Promise<object>} CVGetResult 的 data 字段
 */
async function pollResult(reqKey, taskId, { maxAttempts = 60, step = '任务' } = {}) {
  const intervalMs = 3000;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    const data = await volcPost('CVGetResult', { req_key: reqKey, task_id: taskId }, `${step}查询`);
    const status = data?.status;
    console.log(`[OmniHuman] ${step}任务 ${taskId} 状态=${status}，第 ${i + 1}/${maxAttempts} 次轮询`);
    if (status === 'done') return data;
    if (status === 'not_found' || status === 'expired') {
      throw new Error(`字节 OmniHuman ${step}任务已失效（status=${status}，task_id=${taskId}），请重新提交`);
    }
    if (!POLL_PENDING_STATUSES.includes(status)) {
      throw new Error(
        `字节 OmniHuman ${step}返回未知状态（status=${status}，task_id=${taskId}），按失败处理。` +
        '可能是任务以文档未覆盖的失败态结束，请检查输入后重试；若反复出现请核对 req_key 与官方文档状态枚举'
      );
    }
    // in_queue / processing / generating → 继续轮询
  }
  throw new Error(
    `字节 OmniHuman ${step}轮询超时（${maxAttempts} 次 × ${intervalMs / 1000}s，task_id=${taskId}）。` +
    '快速模式生成耗时约为音频时长的 20 倍，长句子可适当再等——任务结果保留 12 小时，可稍后重试同一句话'
  );
}

// ── Provider 对象（契约 §1） ─────────────────────────────────

export default {
  id: 'omnihuman',
  displayName: '字节 OmniHuman',

  /**
   * 配置自检（同步、零网络请求）
   * @returns {{ ready: boolean, missing: string[] }}
   */
  configStatus() {
    const missing = [];
    if (!process.env.VOLC_ACCESS_KEY_ID) missing.push('VOLC_ACCESS_KEY_ID');
    if (!process.env.VOLC_SECRET_ACCESS_KEY) missing.push('VOLC_SECRET_ACCESS_KEY');
    return { ready: missing.length === 0, missing };
  },

  /**
   * 形象预处理：本地图 → 图床中转拿公网 URL → 主体识别（官方「强烈建议」的步骤1，
   * 确认图中含人/类人主体——快速模式对非单人正面照效果差，提前挡掉省 1 元/秒的冤枉钱）。
   *
   * 识别未通过 ≠ 失败：返回 meta.checkPass=false + meta.detectError，由调用方决定降级
   * （与 EMO 的 prepareFigure 语义对齐）。真正失败（图床上传不通 / AK/SK 鉴权失败）：throw Error
   * ——契约 §1「真正失败（网络/鉴权）：throw」，鉴权错误不准吞进 detectError 降级。
   *
   * 注：契约入参里的 ratio 是 EMO 的裁剪比例概念，火山快速模式无对应参数，此处忽略。
   *
   * @param {{ imageBuffer: Buffer, mime: string, ratio: '3:4'|'1:1' }} input
   * @returns {Promise<{ meta: object }>}
   *   meta = { imageUrl, uploadedAt, checkPass, detectError? }
   */
  async prepareFigure({ imageBuffer, mime }) {
    // Step 1: 图床中转（直链 60 分钟有效，过期由 generateVideo 自动重传刷新）
    const imageUrl = await uploadToTmpHost(imageBuffer, mime);
    const meta = { imageUrl, uploadedAt: Date.now(), checkPass: false };

    // Step 2: 主体识别（降级不阻塞——未开通/识别失败时仍可展示静态形象 + 语音对话）
    try {
      const submit = await volcPost(
        'CVSubmitTask',
        { req_key: REQ_KEY_ROLE, image_url: imageUrl },
        '主体识别提交'
      );
      const taskId = submit?.task_id;
      if (!taskId) {
        throw new Error(`字节 OmniHuman 主体识别提交未获得 task_id: ${JSON.stringify(submit)}`);
      }
      const result = await pollResult(REQ_KEY_ROLE, taskId, { maxAttempts: 60, step: '主体识别' });
      // 识别结果在 data.resp_data（JSON 字符串）：{"status":1} 含人主体 / 0 不含
      let parsed = {};
      try { parsed = JSON.parse(result?.resp_data || '{}'); } catch { /* 留空走未通过分支 */ }
      meta.checkPass = parsed.status === 1;
      if (!meta.checkPass) {
        meta.detectError = '主体识别未通过：图中未检测到人物/类人主体，请换一张单人、正面、人脸占比大的照片';
      }
    } catch (e) {
      // 鉴权/配置类失败（AK/SK 缺失或不正确）必须 throw，不准降级——
      // 否则错误的 meta 被持久化，鉴权问题要拖到 generateVideo 才浮现
      if (e.isAuth) throw e;
      meta.detectError = e.message;
      // retryable=true：检测尝试本身异常（50500/50501/轮询超时/网络抖动），下次 speak 会自动重新 prepare；
      // 上面「确定性未通过」（status!==1）分支不带此标记，speak 秒拦截、不重复烧钱
      meta.retryable = true;
      console.warn('[OmniHuman/prepareFigure] 主体识别失败（降级为仅静态形象）:', e.message);
    }
    return { meta };
  },

  /**
   * 对口型视频生成：图床 URL 过期自动重传 → CVSubmitTask（图片+音频）→ 轮询 → 视频 URL。
   *
   * audioUrl 直接用传入的公网 MP3（CosyVoice 产物，24h 有效）——火山就要 URL，无需下载转换。
   * ⚠️ 官方建议音频 <15 秒以保证效果（无明文硬截断），长句子效果可能劣化。
   *
   * @param {{ imageBuffer: Buffer|null, mime: string, meta: object, audioUrl: string, text: string }} input
   *   meta 可能被原地更新（imageUrl/uploadedAt 刷新），调用方负责在调用后持久化。
   * @returns {Promise<{ videoUrl: string }>}
   *   videoUrl 仅 1 小时有效，调用方需立即下载落盘。
   */
  async generateVideo({ imageBuffer, mime, meta, audioUrl }) {
    // 图床直链只有 60 分钟有效；缺失或快过期就用本地原图重传一份
    if (!meta?.imageUrl || Date.now() - (meta.uploadedAt || 0) > TMP_URL_TTL_MS) {
      if (!imageBuffer) {
        throw new Error(
          '字节 OmniHuman：形象图床 URL 已过期且本地原图丢失，无法刷新。' +
          '请到「设置 → 形象图片」重新生成或上传照片'
        );
      }
      console.log('[OmniHuman/generateVideo] 形象图床 URL 缺失或已过期，重新上传刷新...');
      meta.imageUrl = await uploadToTmpHost(imageBuffer, mime);
      meta.uploadedAt = Date.now(); // 原地更新 meta，由调用方持久化
    }

    // 提交视频生成任务（计费提醒：1 元/秒视频，10 秒一条约 10 元）
    const submit = await volcPost(
      'CVSubmitTask',
      { req_key: REQ_KEY_VIDEO, image_url: meta.imageUrl, audio_url: audioUrl },
      '视频生成提交'
    );
    const taskId = submit?.task_id;
    if (!taskId) {
      throw new Error(`字节 OmniHuman 视频生成提交未获得 task_id: ${JSON.stringify(submit)}`);
    }

    // 轮询：间隔 3s 沿用 emo 纪律；上限放宽到 200 次（10 分钟）——官方标注 RTF≈20，
    // 10 秒音频要 ~200 秒，emo 的 60 次（3 分钟）对快速模式必然超时（决策已上报）
    const result = await pollResult(REQ_KEY_VIDEO, taskId, { maxAttempts: 200, step: '视频生成' });

    // 快速模式视频地址在 data.video_url（顶层直接字段，不在 resp_data 里——
    // 别套用 85128 克隆数字人的 resp_data.vid.url 解析路径）
    const videoUrl = result?.video_url;
    if (!videoUrl) {
      throw new Error(
        `字节 OmniHuman 视频生成完成但无 video_url（task_id=${taskId}）: ${JSON.stringify(result).slice(0, 300)}`
      );
    }
    return { videoUrl };
  },
};
