/**
 * API 客户端 —— 封装所有 /api fetch 调用
 * SSE 流式读取也在这里，保持 composable 层干净
 */

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

  const resp = await fetch('/api/chat', {
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
  const r = await fetch('/api/avatar/realhuman/speak', {
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
  const r = await fetch('/api/avatar/realhuman/figure', {
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
  const r = await fetch('/api/avatar/realhuman/figure/upload', {
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
  await fetch('/api/avatar/realhuman/figure', { method: 'DELETE' });
}

/**
 * 获取形象配置（含当前缓存形象）
 */
export async function getAvatarConfig() {
  const r = await fetch('/api/avatar/config');
  return r.json();
}

/**
 * 获取视频 provider 列表和当前选中
 */
export async function getVideoProvider() {
  const r = await fetch('/api/avatar/realhuman/provider');
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
  const r = await fetch('/api/avatar/realhuman/provider', {
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
  const r = await fetch('/api/avatar/realhuman/speak-cache');
  const data = await r.json();
  return data.items || [];
}

/**
 * 删除话术库单条
 */
export async function deleteSpeakCacheItem(key) {
  await fetch('/api/avatar/realhuman/speak-cache/' + key, { method: 'DELETE' });
}

/**
 * 清空话术库
 */
export async function clearSpeakCache() {
  await fetch('/api/avatar/realhuman/speak-cache', { method: 'DELETE' });
}

/**
 * 健康检查（获取 ASR provider 等配置）
 */
export async function getHealth() {
  const r = await fetch('/api/health');
  return r.json();
}
