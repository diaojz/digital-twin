/**
 * realhuman/providers/index.js
 *
 * 视频 provider 注册表（契约 §2）：
 *   emo       = 阿里 EMO（DashScope 悦动人像）
 *   omnihuman = 字节 OmniHuman（火山引擎，AK/SK 签名）
 *   seedance  = 字节 Seedance 2.0（火山方舟，Bearer key）
 *
 * 「视频 provider」专指对口型视频生成后端，与 LLM/TTS/ASR 的 provider 概念无关。
 */

import emo from './emo.js';
import omnihuman from './omnihuman.js';
import seedance from './seedance.js';

export const providers = { emo, omnihuman, seedance };

/**
 * 按 id 取 provider，未知 id 直接 throw（调用方决定怎么兜底）
 * @param {string} id  'emo' | 'omnihuman' | 'seedance'
 */
export function getProvider(id) {
  const p = providers[id];
  if (!p) {
    throw new Error(`未知视频 provider: ${id}（可选 ${Object.keys(providers).join(' / ')}）`);
  }
  return p;
}

/**
 * 列出全部 provider 及各自配置就绪状态（供切换端点 / 前端分段控件渲染）
 * @returns {Array<{ id: string, displayName: string, ready: boolean, missing: string[] }>}
 */
export function listProviders() {
  return Object.values(providers).map(p => {
    const { ready, missing } = p.configStatus();
    return { id: p.id, displayName: p.displayName, ready, missing };
  });
}
