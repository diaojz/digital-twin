/**
 * chat store —— 消息列表、五色状态机、输入态
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

// 状态机标签文本
const STATE_LABEL = { idle: '待机', listen: '聆听中…', think: '思考中', gen: '生成中', speak: '说话中' };
const STATE_TEXT  = { idle: '在线', listen: '在听你说', think: '在想…', gen: '准备开口', speak: '说话中' };

export const useChatStore = defineStore('chat', () => {
  // 对话历史（{role, content}[]，发给后端用）
  const messages = ref([]);
  // 界面显示用的气泡列表（{role, content}[]，role: 'ai'|'me'|'sys'）
  const bubbles = ref([]);
  // 五色状态：idle | listen | think | gen | speak
  const uiState = ref('idle');
  // 输入框禁用态
  const busy = ref(false);

  function addBubble(role, content) {
    const bubble = { role, content, id: Date.now() + Math.random() };
    bubbles.value.push(bubble);
    return bubble;
  }

  function updateLastAiBubble(content) {
    for (let i = bubbles.value.length - 1; i >= 0; i--) {
      if (bubbles.value[i].role === 'ai') {
        bubbles.value[i].content = content;
        return;
      }
    }
  }

  function setState(s) {
    uiState.value = s;
  }

  function setInputEnabled(on) {
    busy.value = !on;
  }

  const stateLabel = () => STATE_LABEL[uiState.value] || '待机';
  const stateText  = () => STATE_TEXT[uiState.value]  || '在线';

  return {
    messages,
    bubbles,
    uiState,
    busy,
    addBubble,
    updateLastAiBubble,
    setState,
    setInputEnabled,
    stateLabel,
    stateText,
  };
});
