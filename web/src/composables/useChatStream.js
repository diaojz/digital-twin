/**
 * useChatStream —— 完整一轮对话的编排
 * 职责：拉 LLM 流式回复 → 触发 speak → 控制舞台状态机
 *
 * 注意：Pinia setup store 导出的 ref 在 store 实例上已自动解包，
 * 访问时直接用 chatStore.messages（数组），而不是 chatStore.messages.value
 */
import { useAudioQueue } from './useAudioQueue.js';
import { chatStream, speak } from '../api/client.js';
import { useChatStore } from '../stores/chat.js';
import { useSettingsStore } from '../stores/settings.js';
import { useAvatarStore } from '../stores/avatar.js';

export function useChatStream({ videoEl, toast, showStatic, showVideo }) {
  const chatStore    = useChatStore();
  const settingsStore = useSettingsStore();
  const avatarStore  = useAvatarStore();
  const { playAudio, waitVideoEnd } = useAudioQueue();

  async function sendMessage(text) {
    text = (text || '').trim();
    if (!text || chatStore.busy) return;

    chatStore.setInputEnabled(false);
    chatStore.addBubble('me', text);
    chatStore.messages.push({ role: 'user', content: text });

    // 1) LLM 流式回复
    chatStore.setState('think');
    const aiBubble = chatStore.addBubble('ai', '');
    let reply = '';
    try {
      reply = await chatStream(
        chatStore.messages.slice(-20),
        settingsStore.currentPersonaPrompt(),
        (_delta, full) => {
          // 实时更新气泡
          const idx = chatStore.bubbles.findIndex(b => b.id === aiBubble.id);
          if (idx !== -1) chatStore.bubbles[idx].content = full;
        },
      );
    } catch (e) {
      reply = '我都听着呢，你慢慢说～（网络好像有点慢）';
      console.error('[ChatStream] LLM 调用失败:', e);
      const idx = chatStore.bubbles.findIndex(b => b.id === aiBubble.id);
      if (idx !== -1) chatStore.bubbles[idx].content = reply;
    }
    if (!reply.trim()) {
      reply = '我在呢，再跟我说说？';
      const idx = chatStore.bubbles.findIndex(b => b.id === aiBubble.id);
      if (idx !== -1) chatStore.bubbles[idx].content = reply;
    }
    chatStore.messages.push({ role: 'assistant', content: reply });

    // 2) 语音 + 形象
    const mayGenVideo = avatarStore.figureReady && settingsStore.lipsyncInChat;
    chatStore.setState(mayGenVideo ? 'gen' : 'think');

    let genTimer = null;
    if (mayGenVideo) {
      let gt0 = Date.now();
      genTimer = setInterval(() => {
        const sec = Math.round((Date.now() - gt0) / 1000);
        document.dispatchEvent(new CustomEvent('gen-progress', { detail: `EMO 生成视频中… 已 ${sec} 秒（通常 40-60 秒）` }));
      }, 500);
    }
    const clearGenTimer = () => { if (genTimer) { clearInterval(genTimer); genTimer = null; } };

    try {
      const data = await speak({
        text: reply,
        voice: settingsStore.voice,
        rate: settingsStore.rate,
        pitch: settingsStore.pitch,
        volume: settingsStore.volume,
        lipsync: settingsStore.lipsyncInChat,
      });
      clearGenTimer();

      if (data.videoUrl) {
        // 命中话术库：同步字幕
        if (data.matchedText && data.matchedText !== reply) {
          const idx = chatStore.bubbles.findIndex(b => b.id === aiBubble.id);
          if (idx !== -1) chatStore.bubbles[idx].content = data.matchedText;
          chatStore.messages[chatStore.messages.length - 1].content = data.matchedText;
          toast('⚡ 命中预生成话术，秒出对口型', 2200);
        }
        chatStore.setState('speak');
        showVideo(data.videoUrl);
        await waitVideoEnd(videoEl.value);
      } else if (data.audioUrl) {
        chatStore.setState('speak');
        showStatic();
        await playAudio(data.audioUrl);
      } else {
        throw new Error(data.error || '语音合成失败');
      }
    } catch (e) {
      clearGenTimer();
      toast('语音回复失败：' + (e.message || e) + '，已显示文字');
      console.error('[ChatStream] speak 失败:', e);
      showStatic();
    }

    chatStore.setState('idle');
    showStatic();
    chatStore.setInputEnabled(true);
  }

  return { sendMessage };
}
