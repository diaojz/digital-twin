<template>
  <!-- 消息列表 + 输入条 + 🎬 chips + 麦克风按钮 -->
  <div class="chat" ref="chatEl">
    <div
      v-for="bubble in chatStore.bubbles"
      :key="bubble.id"
      class="msg"
      :class="bubble.role"
    >{{ bubble.content }}</div>
  </div>

  <!-- 快捷 chips（预设问题 + 话术库 🎬 chips） -->
  <div class="quick" id="quickRow">
    <span @click="onQuickSend('今天过得怎么样')">今天过得怎么样</span>
    <span @click="onQuickSend('讲个开心的事')">讲个开心的事</span>
    <span @click="onQuickSend('我想你了')">我想你了</span>
    <span
      v-for="chip in avatarStore.quickChips"
      :key="chip.key"
      class="lib"
      :title="'点击秒出：' + chip.text"
      @click="playLibEntry(chip)"
    >🎬 {{ chip.text }}</span>
  </div>

  <!-- 输入条 -->
  <div class="inbar">
    <button
      class="ib mic"
      :class="{ rec: recorderRecording }"
      :title="micTitle"
      :disabled="isMicDisabled"
      @click="onMicClick"
    >🎤</button>
    <input
      ref="inputEl"
      v-model="inputText"
      :placeholder="chatStore.busy ? '小忆正在准备回应…' : '和小忆说点什么…'"
      :disabled="chatStore.busy"
      @keydown.enter="onSend"
    >
    <button
      class="ib send"
      :disabled="chatStore.busy"
      @click="onSend"
    >➤</button>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import { useChatStore } from '../stores/chat.js';
import { useAvatarStore } from '../stores/avatar.js';
import { useSettingsStore } from '../stores/settings.js';

const props = defineProps({
  sendMessage:  { type: Function, required: true },
  recording:    { type: Object,   required: true },  // ref<boolean>
  toggleMic:    { type: Function, required: true },
  asrProvider:  { type: Object,   required: true },  // ref<string>
  toast:        { type: Function, required: true },
  playLibEntry: { type: Function, required: true },
  go:           { type: Function, required: true },
});

const chatStore    = useChatStore();
const avatarStore  = useAvatarStore();

const chatEl    = ref(null);
const inputEl   = ref(null);
const inputText = ref('');

// 给 recorder onTranscript 使用（webspeech 实时填字）
defineExpose({ setInputText: (t) => { inputText.value = t; } });

// 录音状态
const recorderRecording = computed(() => props.recording.value);

const micTitle = computed(() => {
  const p = props.asrProvider.value;
  if (p === 'whisper') return '点击开始录音，再点一次结束（本地 Whisper 识别）';
  if (p === 'dashscope') return '点击开始录音，再点一次结束（百炼云端识别）';
  return '语音输入';
});

const isMicDisabled = computed(() => chatStore.busy && !recorderRecording.value);

function onMicClick() {
  props.toggleMic(chatStore.busy);
}

function onSend() {
  const t = inputText.value.trim();
  if (!t) return;
  props.sendMessage(t);
  inputText.value = '';
}

function onQuickSend(t) {
  props.go('chat');
  props.sendMessage(t);
}

// 自动滚动到底部
watch(
  () => chatStore.bubbles.length,
  async () => {
    await nextTick();
    if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight;
  },
);

// 最后一条 AI 气泡内容变化时也滚到底（流式更新）
watch(
  () => {
    const last = chatStore.bubbles[chatStore.bubbles.length - 1];
    return last ? last.content : '';
  },
  async () => {
    await nextTick();
    if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight;
  },
);
</script>
