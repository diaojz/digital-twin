<template>
  <!-- 视频生成后端四选一 -->
  <div class="seg">🎛️ 视频生成后端（对口型四选一）</div>
  <div class="segbtns" style="flex-wrap:wrap;">
    <template v-if="settingsStore.videoProviders.length === 0">
      <div style="font-size:11px;color:var(--ink-faint);padding:4px 2px;">加载中…</div>
    </template>
    <template v-else>
      <div
        v-for="p in settingsStore.videoProviders"
        :key="p.id"
        class="sb"
        :class="{ on: p.id === settingsStore.videoProvider }"
        :title="p.ready ? '' : '缺：' + ((p.missing || []).join(' / ') || '对应 env key') + '（仍可选，只能播已缓存视频）'"
        @click="onSwitch(p.id)"
      >
        {{ p.displayName || p.id }}
        <small>{{ p.ready ? '✅ 已配置' : '⚠️ 缺 key' }}</small>
      </div>
    </template>
  </div>
  <div class="card" style="margin-top:8px;padding:9px 14px;">
    <div style="font-size:11px;color:var(--ink-faint);line-height:1.6;">⚠️ 缺 key 的后端也能选——只能播放它已缓存的视频；要生成新视频，先在 .env 填好对应 key 再重启。</div>
  </div>
</template>

<script setup>
import { useSettingsStore } from '../../stores/settings.js';
import { switchVideoProvider } from '../../api/client.js';

const settingsStore = useSettingsStore();

const props = defineProps({
  toast:             { type: Function, required: true },
  refreshSpeakLib:   { type: Function, required: true },
  refreshQuickChips: { type: Function, required: true },
});

async function onSwitch(id) {
  if (!id || id === settingsStore.videoProvider) return;
  try {
    const data = await switchVideoProvider(id);
    settingsStore.videoProvider = data.current;
    const p = settingsStore.videoProviders.find(x => x.id === data.current);
    if (data.warning) props.toast('⚠️ ' + data.warning, 4500);
    else props.toast('已切换到 ' + (p ? p.displayName : data.current), 2200);
    props.refreshSpeakLib();
    props.refreshQuickChips();
  } catch (e) {
    props.toast('切换失败：' + (e.message || e), 3500);
    console.error('[VideoProvider] 切换失败:', e);
  }
}
</script>
