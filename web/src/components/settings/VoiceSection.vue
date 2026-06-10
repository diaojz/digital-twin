<template>
  <!-- 音色 + 语音微调 -->
  <div class="seg">🔊 音色</div>
  <div class="card">
    <div class="chips">
      <div
        v-for="vc in voiceList"
        :key="vc.id"
        class="chip"
        :class="{ on: settingsStore.voice === vc.id }"
        @click="settingsStore.voice = vc.id"
      >
        {{ vc.name }}<small>{{ vc.desc }}</small>
      </div>
    </div>
  </div>

  <div class="seg">🎚️ 语音微调</div>
  <div class="card">
    <div class="slider">
      <span class="sl">语速</span>
      <input type="range" min="0.5" max="2" step="0.1"
        :value="settingsStore.rate"
        @input="settingsStore.rate = parseFloat($event.target.value)"
      >
      <span class="val">{{ settingsStore.rate.toFixed(1) }}</span>
    </div>
    <div class="slider">
      <span class="sl">语调</span>
      <input type="range" min="0.5" max="2" step="0.1"
        :value="settingsStore.pitch"
        @input="settingsStore.pitch = parseFloat($event.target.value)"
      >
      <span class="val">{{ settingsStore.pitch.toFixed(1) }}</span>
    </div>
    <div class="slider">
      <span class="sl">音量</span>
      <input type="range" min="0" max="100" step="5"
        :value="settingsStore.volume"
        @input="settingsStore.volume = parseInt($event.target.value)"
      >
      <span class="val">{{ settingsStore.volume }}</span>
    </div>
  </div>
</template>

<script setup>
import { useSettingsStore } from '../../stores/settings.js';

const settingsStore = useSettingsStore();

const voiceList = [
  { id: 'longwan_v2',       name: '龙婉',    desc: '温柔女声' },
  { id: 'longcheng_v2',     name: '龙橙',    desc: '活泼女声' },
  { id: 'longhua_v2',       name: '龙华',    desc: '知性女声' },
  { id: 'longshu_v2',       name: '龙书',    desc: '沉稳男声' },
  { id: 'longxiaocheng_v2', name: '龙小诚',  desc: '磁性男声' },
  { id: 'longfei_v2',       name: '龙飞',    desc: '热血男声' },
];
</script>
