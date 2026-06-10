<template>
  <!-- 设置抽屉 —— 所有设置子 section 的容器 -->
  <div class="panel-h">调一调你的数字人</div>
  <div class="panel-s">形象 / 声音 / 性格 · 改完下一轮生效</div>

  <FigureSection :go="go" />

  <VideoProviderSection
    :toast="toast"
    :refreshSpeakLib="refreshSpeakLib"
    :refreshQuickChips="refreshQuickChips"
  />

  <SpeakLibSection
    ref="speakLibRef"
    :toast="toast"
    :refreshQuickChips="refreshQuickChips"
    :playVideo="playVideo"
  />

  <VoiceSection />

  <PersonaSection
    :go="go"
    :toast="toast"
    :stopRecording="stopRecording"
  />

  <button class="btn" @click="go('chat')">完成</button>
</template>

<script setup>
import { ref } from 'vue';
import FigureSection from './settings/FigureSection.vue';
import VideoProviderSection from './settings/VideoProviderSection.vue';
import VoiceSection from './settings/VoiceSection.vue';
import PersonaSection from './settings/PersonaSection.vue';
import SpeakLibSection from './settings/SpeakLibSection.vue';

const props = defineProps({
  go: { type: Function, required: true },
  toast: { type: Function, required: true },
  refreshQuickChips: { type: Function, required: true },
  playVideo: { type: Function, required: true },
  stopRecording: { type: Function, required: true },
});

const speakLibRef = ref(null);

function refreshSpeakLib() {
  speakLibRef.value?.refreshSpeakLib();
}

// 每次进设置页刷新话术库列表（和旧版 go('settings') 时调用 renderSpeakLib 行为一致）
defineExpose({ refreshSpeakLib });
</script>
