<template>
  <!-- 性格展示 -->
  <div class="seg">😊 性格</div>
  <div class="card">
    <div class="row" style="cursor:pointer;" @click="go('persona')">
      <div class="ri">💜</div>
      <div class="rt">
        <div class="t1">{{ settingsStore.currentPersonaName() }}</div>
        <div class="t2">{{ currentPersonaDesc }}</div>
      </div>
      <div class="pick">更换 ›</div>
    </div>
  </div>

  <!-- 画幅 -->
  <div class="seg">🖼️ 画幅（影响费用，换形象后生效）</div>
  <div class="segbtns">
    <div
      v-for="r in ratioList"
      :key="r.id"
      class="sb"
      :class="{ on: settingsStore.ratio === r.id }"
      @click="settingsStore.ratio = r.id"
    >
      {{ r.label }}<small>{{ r.desc }}</small>
    </div>
  </div>

  <!-- 语音输入开关 -->
  <div class="seg">🎙️ 语音输入</div>
  <div class="card">
    <div class="row" style="cursor:pointer;" @click="onAutoSendToggle">
      <div class="ri">📤</div>
      <div class="rt">
        <div class="t1">说完自动发送</div>
        <div class="t2">录完直接发；关掉则填入输入框，可改字再发</div>
      </div>
      <div class="toggle" :class="{ on: settingsStore.autoSend }"></div>
    </div>
    <div class="row" style="cursor:pointer;" @click="onContinuousToggle">
      <div class="ri">🔄</div>
      <div class="rt">
        <div class="t1">持续对话（免手）</div>
        <div class="t2">AI 回完自动开麦听你说；关掉省电</div>
      </div>
      <div class="toggle" :class="{ on: settingsStore.continuousMode }"></div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useSettingsStore, PERSONAS } from '../../stores/settings.js';

const settingsStore = useSettingsStore();

const props = defineProps({
  go: { type: Function, required: true },
  toast: { type: Function, required: true },
  stopRecording: { type: Function, required: true },
});

const currentPersonaDesc = computed(() => {
  if (settingsStore.personaCustom.trim()) return '自定义提示词';
  return PERSONAS[settingsStore.persona]?.ds || '';
});

const ratioList = [
  { id: '1:1', label: '1:1 方形', desc: '0.08 元/秒 · 省' },
  { id: '3:4', label: '3:4 竖屏', desc: '0.16 元/秒 · 好看' },
];

function onAutoSendToggle() {
  settingsStore.autoSend = !settingsStore.autoSend;
  props.toast(settingsStore.autoSend ? '已开启：说完自动发送' : '已关闭：识别后可改字再发', 2000);
}

function onContinuousToggle() {
  settingsStore.continuousMode = !settingsStore.continuousMode;
  props.toast(settingsStore.continuousMode ? '已开启：AI 回完自动开麦' : '已关闭：需手动点麦克风', 2200);
  if (!settingsStore.continuousMode) {
    props.stopRecording();
  }
}
</script>
