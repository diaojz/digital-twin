/**
 * settings store —— 音色/语速/人设/开关/videoProvider
 * 沿用旧版 localStorage key 命名（老用户设置无缝继承）
 * 旧版直接存在 state 对象里并没有持久化到 localStorage，
 * 所以这里只持久化明确需要跨刷新的设置项。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const PERSONAS = {
  gentle: {
    em: '💜', nm: '温柔陪伴', ds: '轻声慢语，先接住情绪',
    prompt: '你是温柔治愈的陪伴型数字人小忆。说话轻声慢语，先接住对方情绪再回应，常说「我在呢」「别急，我陪着你」。回复简短自然，像家人一样亲切，控制在40字内。',
  },
  smart: {
    em: '🧭', nm: '知性可靠', ds: '沉稳靠谱，把事说清楚，给简单建议',
    prompt: '你是知性可靠的数字人小忆。说话沉稳清晰，把事情说明白，必要时给一两条简单实用的建议。语气温和不啰嗦，回复控制在40字内。',
  },
  sunny: {
    em: '☀️', nm: '阳光活泼', ds: '热情有活力，带动情绪，多用「太好啦」',
    prompt: '你是阳光活泼的数字人小忆。热情有活力，善于带动情绪，常说「太好啦」「我们一起」。语气欢快俏皮，回复简短，控制在40字内。',
  },
};

// provider 徽章短名
export const PROVIDER_BADGE = { emo: 'EMO', omnihuman: 'OmniHuman', seedance: 'Seedance' };

export const useSettingsStore = defineStore('settings', () => {
  // 音色
  const voice = ref('longwan_v2');
  // 画幅
  const ratio = ref('3:4');
  // 语音微调
  const rate  = ref(1.0);
  const pitch = ref(1.0);
  const volume = ref(50);
  // 性格
  const persona = ref('gentle');
  const personaCustom = ref('');
  // 开关
  const autoSend     = ref(true);   // 语音识别后自动发送
  const continuousMode = ref(true); // 持续对话
  const lipsyncInChat  = ref(false);// 对话时现场生成对口型
  // 视频 provider
  const videoProvider  = ref('emo');
  const videoProviders = ref([]);   // [{id, displayName, ready, missing}]

  // 计算当前性格名（设置面板展示用）
  function currentPersonaName() {
    if (personaCustom.value.trim()) return '自定义性格';
    return PERSONAS[persona.value]?.nm || '温柔陪伴';
  }

  // 当前 persona 系统提示词
  function currentPersonaPrompt() {
    return personaCustom.value.trim() || PERSONAS[persona.value]?.prompt || '';
  }

  return {
    voice, ratio, rate, pitch, volume,
    persona, personaCustom,
    autoSend, continuousMode, lipsyncInChat,
    videoProvider, videoProviders,
    currentPersonaName, currentPersonaPrompt,
  };
});
