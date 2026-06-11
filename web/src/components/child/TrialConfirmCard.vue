<template>
  <!-- C1 第四卡：试看确认 -->
  <div class="workshop-card">
    <div class="wc-header">
      <div class="wc-icon" style="background:linear-gradient(160deg,#fff0e0,#fbe7f0);">👀</div>
      <div class="wc-title">试看确认 · 像不像你？</div>
      <div v-if="confirmed" class="wc-badge">已确认 ✓</div>
    </div>

    <!-- 试看视频缩略卡 -->
    <div
      v-if="sample"
      style="display:flex;align-items:center;gap:10px;background:linear-gradient(160deg,#b7a4ec,#e6c4e0);border-radius:10px;padding:6px 12px;margin-bottom:8px;cursor:pointer;"
      @click="$emit('play', sample)"
    >
      <span style="font-size:20px;flex:none;">🎬</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(80,50,140,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ sample.text }}</div>
      </div>
      <div style="width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 2px 6px rgba(120,80,180,.3);flex:none;">▶</div>
    </div>
    <div
      v-else
      style="font-size:11px;color:var(--ink-faint);background:rgba(255,255,255,.6);border-radius:10px;padding:9px 12px;margin-bottom:8px;line-height:1.5;"
    >
      话术库还没有视频，先去「话术库」生成一条，再回来试看确认。
    </div>

    <button
      class="btn sm"
      style="padding:8px;font-size:12px;margin-top:0;"
      :disabled="confirmed"
      @click="$emit('confirm')"
    >{{ confirmed ? '✓ 已确认像你，邀请链接已开放' : '✓ 像我，开始邀请爸妈' }}</button>

    <div style="font-size:10px;color:var(--ink-faint);text-align:center;line-height:1.4;margin-top:6px;">
      确认后才能在「家庭」页生成邀请链接（F1 质检关卡）
    </div>
  </div>
</template>

<script setup>
defineProps({
  confirmed: { type: Boolean, default: false },
  sample:    { type: Object,  default: null }, // 话术库任一条 { text, path }
});
defineEmits(['confirm', 'play']);
</script>
