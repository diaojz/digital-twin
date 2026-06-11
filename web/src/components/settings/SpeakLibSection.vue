<template>
  <!-- 对口型视频话术库 -->
  <div class="seg">🎬 对口型视频</div>
  <div class="card">
    <!-- 对话时生成对口型开关 -->
    <div class="row" style="cursor:pointer;" @click="onLipsyncToggle">
      <div class="ri">🎬</div>
      <div class="rt">
        <div class="t1">对话时生成对口型</div>
        <div class="t2">{{ settingsStore.videoProvider === 'wans2v'
          ? '开：每句现场生成全身动作视频(约5-10分钟，须<70字)；关：对话只用缓存视频+语音，更流畅'
          : '开：每句现场生成嘴型(慢~40s)；关：对话只用缓存视频+语音，更流畅' }}</div>
      </div>
      <div class="toggle" :class="{ on: settingsStore.lipsyncInChat }"></div>
    </div>

    <!-- 预生成话术库 -->
    <div style="padding:10px 2px;border-bottom:1px solid var(--line);">
      <div style="font-size:12px;color:#4a3f70;font-weight:600;margin-bottom:6px;">预生成对口型话术库（对话说到相同的话，标点不同也秒出视频）</div>
      <textarea
        class="prompt-box"
        v-model="lipsyncText"
        placeholder="输入一句小忆常说的话，比如开场白…"
        style="min-height:46px;"
      ></textarea>
      <button class="btn ghost" :disabled="lipsyncGenerating" @click="onLipsyncGen" style="margin-top:8px;">
        {{ lipsyncGenerating ? '🎬 生成中…' : '🎬 生成这句的对口型视频' }}
      </button>
      <div v-if="lipsyncGenerating" style="margin-top:8px;">
        <div style="height:6px;border-radius:3px;background:#e0d6f4;overflow:hidden;">
          <div :style="{ width: lipsyncProgress + '%' }" style="height:100%;background:linear-gradient(90deg,var(--p1),var(--p2));transition:width .4s;"></div>
        </div>
        <div style="font-size:10.5px;color:var(--ink-faint);margin-top:5px;text-align:center;">{{ lipsyncProgressText }}</div>
      </div>
    </div>

    <!-- 已生成的视频列表 -->
    <div style="padding:10px 2px;border-bottom:1px solid var(--line);">
      <div style="font-size:12px;color:#4a3f70;font-weight:600;margin-bottom:6px;">已生成的视频（存在本地，刷新/重启都不丢）</div>
      <div v-if="avatarStore.speakLibItems.length === 0" style="font-size:11px;color:var(--ink-faint);">还没有视频，用上面输入框预生成一句试试</div>
      <div v-else style="display:flex;flex-direction:column;gap:6px;">
        <div
          v-for="it in avatarStore.speakLibItems"
          :key="it.key"
          style="display:flex;align-items:center;gap:8px;background:#f4f0fb;border-radius:10px;padding:7px 10px;"
        >
          <span style="font-size:9.5px;color:#8a7ab0;border:1px solid #d6cdf0;border-radius:6px;padding:1px 5px;flex:none;">
            {{ PROVIDER_BADGE[it.provider || 'emo'] || (it.provider || 'emo') }}
          </span>
          <span v-if="!it.current" style="font-size:9.5px;color:#b08aa0;border:1px solid #e3c8d6;border-radius:6px;padding:1px 5px;flex:none;">旧形象</span>
          <div style="flex:1;min-width:0;font-size:11.5px;color:#4a3f70;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" :title="it.text">
            {{ it.text }}
          </div>
          <div class="pick" style="cursor:pointer;flex:none;" @click="onPlay(it)">▶ 播放</div>
          <div style="cursor:pointer;flex:none;font-size:12px;color:var(--ink-faint);padding:2px 4px;" @click="onDelete(it)">✕</div>
        </div>
      </div>
    </div>

    <!-- 清除缓存 -->
    <div class="row" style="cursor:pointer;" @click="onClearAll">
      <div class="ri">🗑️</div>
      <div class="rt">
        <div class="t1">清除视频缓存</div>
        <div class="t2">清掉所有已生成的对口型视频</div>
      </div>
      <div class="pick">清除</div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useSettingsStore, PROVIDER_BADGE } from '../../stores/settings.js';
import { useAvatarStore } from '../../stores/avatar.js';
import { getSpeakCache, deleteSpeakCacheItem, clearSpeakCache, speak } from '../../api/client.js';

const settingsStore = useSettingsStore();
const avatarStore   = useAvatarStore();

const props = defineProps({
  toast:             { type: Function, required: true },
  refreshQuickChips: { type: Function, required: true },
  playVideo:         { type: Function, required: true },
});

const lipsyncText         = ref('');
const lipsyncGenerating   = ref(false);
const lipsyncProgress     = ref(0);
const lipsyncProgressText = ref('生成中…');

function onLipsyncToggle() {
  settingsStore.lipsyncInChat = !settingsStore.lipsyncInChat;
  props.toast(
    settingsStore.lipsyncInChat
      ? '已开启：对话现场生成对口型（每句较慢）'
      : '已关闭：对话用缓存视频+语音（流畅）',
    2600,
  );
}

async function onLipsyncGen() {
  const t = lipsyncText.value.trim();
  if (!t) { props.toast('先输入一句话'); return; }
  if (!avatarStore.figureReady) { props.toast('请先在「形象图片」里生成形象'); return; }

  lipsyncGenerating.value = true;
  lipsyncProgress.value = 0;
  // 进度估算按当前 provider：万相全身官方约 5-10 分钟（短句更快），EMO 通常 40-60 秒
  const isS2V = settingsStore.videoProvider === 'wans2v';
  const startT = Date.now(), EST = isS2V ? 480000 : 50000;
  const hint = isS2V ? '官方约 5-10 分钟，短句更快' : '通常 40-60 秒';
  const timer = setInterval(() => {
    const el = Date.now() - startT;
    lipsyncProgress.value = Math.min(95, (el / EST) * 100);
    const sec = Math.round(el / 1000);
    const elapsed = sec >= 90 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
    lipsyncProgressText.value = `生成中… 已 ${elapsed}（${hint}）`;
  }, 500);

  try {
    const d = await speak({
      text: t,
      voice: settingsStore.voice,
      rate: settingsStore.rate,
      pitch: settingsStore.pitch,
      volume: settingsStore.volume,
      lipsync: true,
    });
    if (d.videoUrl) {
      lipsyncProgress.value = 100;
      lipsyncProgressText.value = '✅ 完成！已入话术库，对话说到这句话秒出对口型';
      props.toast('✅ 已生成并缓存', 3000);
      await refreshSpeakLib();
      props.refreshQuickChips();
    } else {
      throw new Error(d.videoError || d.error || '生成失败');
    }
  } catch (e) {
    lipsyncProgressText.value = '❌ ' + (e.message || e);
    props.toast('生成失败：' + (e.message || e), 3500);
    console.error('[SpeakLib] 预生成失败:', e);
  } finally {
    clearInterval(timer);
    lipsyncGenerating.value = false;
    setTimeout(() => { lipsyncProgress.value = 0; }, 2500);
  }
}

async function refreshSpeakLib() {
  try {
    avatarStore.speakLibItems = await getSpeakCache();
  } catch (e) {
    console.error('[SpeakLib] 加载失败:', e);
  }
}

defineExpose({ refreshSpeakLib });

function onPlay(it) {
  props.playVideo(it.path, it.text);
}

async function onDelete(it) {
  if (!confirm('删除这条视频？')) return;
  try {
    await deleteSpeakCacheItem(it.key);
    props.toast('已删除');
    await refreshSpeakLib();
    props.refreshQuickChips();
  } catch (e) {
    props.toast('删除失败：' + (e.message || e));
    console.error('[SpeakLib] 删除失败:', e);
  }
}

async function onClearAll() {
  if (!confirm('清除所有对口型视频缓存？下次说这些话会重新生成')) return;
  try {
    await clearSpeakCache();
    props.toast('对口型视频缓存已清除');
    await refreshSpeakLib();
    props.refreshQuickChips();
  } catch (e) {
    props.toast('清除失败：' + (e.message || e));
    console.error('[SpeakLib] 清除失败:', e);
  }
}
</script>
