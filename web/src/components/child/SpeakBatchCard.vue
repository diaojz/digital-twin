<template>
  <!-- C4 顶部：一键生成常用话术包 -->
  <div class="workshop-card" style="margin-bottom:10px;">
    <div class="wc-header" style="margin-bottom:6px;">
      <div class="wc-icon" style="background:linear-gradient(160deg,#efe6ff,#fbe7f0);">✨</div>
      <div class="wc-title">一键生成常用话术包</div>
    </div>

    <button class="btn ghost sm" style="margin:2px 0 8px;" @click="toggleOpen">
      {{ open ? '收起模板' : '挑选模板（' + templates.length + ' 条）' }}
    </button>

    <div v-if="open">
      <div v-if="loadingTpl" style="font-size:11px;color:var(--ink-faint);padding:4px 0;">加载模板中…</div>
      <div v-else-if="templates.length === 0" style="font-size:11px;color:var(--ink-faint);padding:4px 0;">暂无模板</div>
      <div v-else style="display:flex;flex-direction:column;gap:5px;margin-bottom:8px;">
        <label
          v-for="(t, i) in templates"
          :key="t.id || i"
          style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.7);border-radius:10px;padding:7px 11px;cursor:pointer;"
        >
          <input type="checkbox" :value="i" v-model="picked" style="flex:none;accent-color:var(--p1);">
          <span style="flex:1;min-width:0;font-size:11.5px;color:#4a3f70;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ textOf(t) }}</span>
          <span v-if="t.label || t.category" style="font-size:9.5px;color:var(--p1);flex:none;">{{ t.label || t.category }}</span>
        </label>
      </div>

      <div style="font-size:10.5px;color:var(--orange);background:rgba(230,151,90,.09);border:1px solid rgba(230,151,90,.25);border-radius:10px;padding:6px 10px;margin-bottom:8px;line-height:1.5;">
        ⚠️ 每条会真实生成对口型视频并计费（按额度估秒扣减）。已选 {{ picked.length }} 条。
      </div>

      <button class="btn" :disabled="generating || picked.length === 0" @click="onGenerate">
        {{ generating ? '生成中…' : '✨ 生成选中的 ' + picked.length + ' 条（会计费）' }}
      </button>

      <div v-if="generating || done" style="margin-top:8px;">
        <div style="height:6px;border-radius:3px;background:#e0d6f4;overflow:hidden;">
          <div :style="{ width: progress + '%' }" style="height:100%;background:linear-gradient(90deg,var(--p1),var(--p2));transition:width .4s;"></div>
        </div>
        <div style="font-size:10.5px;color:var(--ink-faint);margin-top:5px;text-align:center;">{{ progressText }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { speakTemplates, speakBatch } from '../../api/client.js';

const props = defineProps({
  toast:       { type: Function, required: true },
  onGenerated: { type: Function, default: () => {} },
});

const open        = ref(false);
const loadingTpl  = ref(false);
const templates   = ref([]);
const picked      = ref([]);
const generating  = ref(false);
const done        = ref(false);
const progress    = ref(0);
const progressText = ref('');

function textOf(t) { return typeof t === 'string' ? t : (t.text || t.label || ''); }

async function toggleOpen() {
  open.value = !open.value;
  if (open.value && templates.value.length === 0) await loadTemplates();
}

async function loadTemplates() {
  loadingTpl.value = true;
  try {
    templates.value = await speakTemplates();
  } catch (e) {
    props.toast('加载模板失败：' + (e.message || e), 3500);
    console.error('[SpeakBatch] 加载模板失败:', e);
  } finally {
    loadingTpl.value = false;
  }
}

async function onGenerate() {
  if (picked.value.length === 0) { props.toast('先勾选要生成的话术'); return; }
  const texts = picked.value.map(i => textOf(templates.value[i])).filter(Boolean);
  generating.value = true;
  done.value = false;
  progress.value = 0;
  progressText.value = '准备生成…';
  let okCount = 0;
  try {
    await speakBatch(texts, (evt) => {
      // evt 形状由后端定：尽量兼容 {index,total,text,ok,error,done}
      const total = evt.total || texts.length;
      const idx = (evt.index != null) ? (evt.index + 1) : okCount;
      if (evt.ok || evt.videoUrl || evt.path) okCount++;
      progress.value = Math.min(100, Math.round((idx / total) * 100));
      progressText.value = evt.error
        ? `第 ${idx}/${total} 条失败：${evt.error}`
        : `已生成 ${idx}/${total} 条…`;
    });
    progress.value = 100;
    progressText.value = `✅ 完成，已入话术库`;
    done.value = true;
    props.toast('话术包已生成', 3000);
    props.onGenerated();
  } catch (e) {
    progressText.value = '❌ ' + (e.message || e);
    props.toast('批量生成失败：' + (e.message || e), 3500);
    console.error('[SpeakBatch] 生成失败:', e);
  } finally {
    generating.value = false;
  }
}
</script>
