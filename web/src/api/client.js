/**
 * API 客户端 —— 封装所有 /api fetch 调用
 * SSE 流式读取也在这里，保持 composable 层干净
 *
 * 统一请求层（区域 H）：
 *   - 自动带 X-Twin-Role 头（值取 localStorage.twin_role，默认 child）
 *   - 自动透传 ?code=（localStorage.twin_code 存在时附加到 query）
 *   所有 fetch 走 apiFetch，确保两端口令/角色一致。
 */

const STORAGE_ROLE = 'twin_role';
const STORAGE_CODE = 'twin_code';

/** 取当前角色，默认 child */
function currentRole() {
  try { return localStorage.getItem(STORAGE_ROLE) || 'child'; } catch (_) { return 'child'; }
}

/** 取当前口令（可能为空） */
function currentCode() {
  try { return localStorage.getItem(STORAGE_CODE) || ''; } catch (_) { return ''; }
}

/** 给 URL 附加 ?code=（已带 code 的不重复加） */
function withCode(url) {
  const code = currentCode();
  if (!code) return url;
  if (/[?&]code=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'code=' + encodeURIComponent(code);
}

/**
 * 统一 fetch：注入 X-Twin-Role 头 + ?code 透传
 * 不动 body / method，调用方一切照旧。
 * @param {string} url
 * @param {RequestInit} [options]
 */
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has('X-Twin-Role')) headers.set('X-Twin-Role', currentRole());
  return fetch(withCode(url), { ...options, headers });
}

/**
 * 发送聊天消息（SSE 流式）
 * @param {Array} messages - [{role, content}]
 * @param {string} personaPrompt - 性格 system prompt
 * @param {Function} onDelta - 收到 token 时的回调 (delta: string) => void
 * @returns {Promise<string>} 完整回复文字
 */
export async function chatStream(messages, personaPrompt, onDelta) {
  const body = { messages };
  if (personaPrompt) body.persona = personaPrompt;

  const resp = await apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error('chat ' + resp.status);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '', full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      if (raw === '[DONE]') continue;
      let j;
      try { j = JSON.parse(raw); } catch (_) { continue; }
      if (j.error) throw new Error(j.error);
      const delta = j.delta || '';
      if (delta) {
        full += delta;
        onDelta(delta, full);
      }
    }
  }
  return full;
}

/**
 * 语音合成 + 形象说话
 * @param {object} opts - {text, voice, rate, pitch, volume, lipsync}
 * @returns {Promise<{videoUrl?, audioUrl?, matchedText?, videoError?}>}
 */
export async function speak(opts) {
  const r = await apiFetch('/api/avatar/realhuman/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '语音合成失败');
  return data;
}

/**
 * 生成形象（文生图 + 人脸检测）
 * @param {string} prompt
 * @param {string} ratio - '3:4' | '1:1'
 * @returns {Promise<{imageUrl, localImage, version, detectError?}>}
 */
export async function generateFigure(prompt, ratio) {
  const r = await apiFetch('/api/avatar/realhuman/figure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, ratio }),
  });
  const data = await r.json();
  if (!r.ok || !data.imageUrl) throw new Error(data.error || '生成失败');
  return data;
}

/**
 * 上传自定义照片
 * @param {string} dataUrl - base64 data URL
 * @param {string} ratio
 * @returns {Promise<{imageUrl, localImage, version, detectError?}>}
 */
export async function uploadFigure(dataUrl, ratio) {
  const r = await apiFetch('/api/avatar/realhuman/figure/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, ratio }),
  });
  const data = await r.json();
  if (!r.ok || !data.imageUrl) throw new Error(data.error || '上传失败');
  return data;
}

/**
 * 重置形象
 */
export async function resetFigure() {
  await apiFetch('/api/avatar/realhuman/figure', { method: 'DELETE' });
}

/**
 * 获取形象配置（含当前缓存形象）
 */
export async function getAvatarConfig() {
  const r = await apiFetch('/api/avatar/config');
  return r.json();
}

/**
 * 获取视频 provider 列表和当前选中
 */
export async function getVideoProvider() {
  const r = await apiFetch('/api/avatar/realhuman/provider');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  if (!Array.isArray(data.providers) || data.providers.length === 0) {
    throw new Error('响应缺少 providers 列表');
  }
  return data;
}

/**
 * 切换视频 provider
 */
export async function switchVideoProvider(id) {
  const r = await apiFetch('/api/avatar/realhuman/provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: id }),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(data.error || '切换失败');
  return data;
}

/**
 * 获取话术库列表
 */
export async function getSpeakCache() {
  const r = await apiFetch('/api/avatar/realhuman/speak-cache');
  const data = await r.json();
  return data.items || [];
}

/**
 * 删除话术库单条
 */
export async function deleteSpeakCacheItem(key) {
  await apiFetch('/api/avatar/realhuman/speak-cache/' + key, { method: 'DELETE' });
}

/**
 * 清空话术库
 */
export async function clearSpeakCache() {
  await apiFetch('/api/avatar/realhuman/speak-cache', { method: 'DELETE' });
}

/**
 * 健康检查（获取 ASR provider 等配置）
 */
export async function getHealth() {
  const r = await apiFetch('/api/health');
  return r.json();
}

// ════════════════════════════════════════════════════════════
// 两端 MVP 新路由（契约 §5.3）—— 形状严格按契约
// ════════════════════════════════════════════════════════════

/**
 * 家庭信息 + 额度（child 视角）
 * @returns {Promise<{id, name, confirmed, members:[...], usage:{...}}>}
 */
export async function getFamily() {
  const r = await apiFetch('/api/family');
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '加载家庭信息失败');
  return data;
}

/**
 * 试看确认（child）
 */
export async function confirmFamily() {
  const r = await apiFetch('/api/family/confirm', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '确认失败');
  return data;
}

/**
 * 重新生成邀请口令（child）
 * @param {'child'|'parent'} role
 * @returns {Promise<{code?, error?}>}
 */
export async function regenCode(role) {
  const r = await apiFetch('/api/family/code/regen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '生成口令失败');
  return data;
}

/**
 * 收件箱列表（按当前角色视角，后端依 X-Twin-Role / code 判定）
 * @returns {Promise<Array>}
 */
export async function listInbox() {
  const r = await apiFetch('/api/inbox');
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '加载收件箱失败');
  return data.messages || data.items || [];
}

/**
 * 单条收件箱详情（双角色）
 * @param {number|string} id
 */
export async function getInbox(id) {
  const r = await apiFetch('/api/inbox/' + id);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '加载消息失败');
  return data;
}

/**
 * 子女语音回信（child）—— audio 为 dataURL
 * 后端立即 202 {ok,status:'generating'}，视频异步生成
 * @param {number|string} id
 * @param {string} audio - "data:audio/...;base64,..."
 * @returns {Promise<{ok, status}>}
 */
export async function replyInbox(id, audio) {
  const r = await apiFetch('/api/inbox/' + id + '/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '回信失败');
  return data;
}

/**
 * 标记已查看（parent）—— 闭环时长指标数据源
 * @param {number|string} id
 */
export async function markViewed(id) {
  const r = await apiFetch('/api/inbox/' + id + '/viewed', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || '标记失败');
  return data;
}

/**
 * 父母端轮询回信（parent）
 * @returns {Promise<Array>}
 */
export async function parentReplies() {
  const r = await apiFetch('/api/parent/replies');
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '加载回信失败');
  return data.replies || data.items || [];
}

/**
 * 父母留言（parent，type:'leave_word'，无 AI 代答）
 * @param {string} text
 */
export async function leaveWord(text) {
  const r = await apiFetch('/api/inbox/leave-word', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '留言失败');
  return data;
}

/**
 * 话术模板（10 条预设）
 * @returns {Promise<Array>}
 */
export async function speakTemplates() {
  const r = await apiFetch('/api/speak-templates');
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '加载模板失败');
  return data.templates || data.items || [];
}

/**
 * 批量生成话术入库（child）—— SSE 回进度
 * @param {string[]} texts
 * @param {Function} [onProgress] - (evt) => void，evt 为后端逐条进度对象
 * @returns {Promise<Array>} 收集到的全部进度事件
 */
export async function speakBatch(texts, onProgress) {
  const resp = await apiFetch('/api/avatar/realhuman/speak-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts }),
  });
  if (!resp.ok || !resp.body) {
    let msg = 'speak-batch ' + resp.status;
    try { const e = await resp.json(); msg = e.error || msg; } catch (_) {}
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  const events = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const raw = t.slice(5).trim();
      if (raw === '[DONE]') continue;
      let j;
      try { j = JSON.parse(raw); } catch (_) { continue; }
      if (j.error) throw new Error(j.error);
      events.push(j);
      if (onProgress) onProgress(j);
    }
  }
  return events;
}
