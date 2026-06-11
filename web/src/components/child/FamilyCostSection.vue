<template>
  <div class="scroll">
    <!-- 家庭成员 -->
    <div class="seg">家庭成员</div>
    <div v-if="loading && members.length === 0" style="font-size:12px;color:var(--ink-faint);padding:8px 2px;">加载中…</div>
    <div
      v-for="m in members"
      :key="m.id || m.role"
      class="family-member"
    >
      <div class="fm-ava">{{ avatarOf(m) }}</div>
      <div class="fm-info">
        <div class="fm-name">{{ nameOf(m) }}</div>
        <div class="fm-status">{{ statusLine(m) }}</div>
      </div>
      <div class="fm-badge" :class="bound(m) ? 'bound' : 'pending'">{{ bound(m) ? '已绑定' : '待邀请' }}</div>
    </div>

    <!-- 邀请/换口令按钮：F1 质检关卡——必须先在「工坊」完成试看确认才放开 -->
    <template v-if="confirmed">
      <button class="btn ghost sm" style="margin-bottom:6px;" @click="copyInvite('parent')">
        微信发邀请链接给爸妈
      </button>
      <button class="btn ghost sm" style="margin-top:4px;margin-bottom:14px;" @click="onRegen('parent')">
        换口令（重新生成爸妈的邀请口令）
      </button>
    </template>
    <div
      v-else
      style="font-size:11.5px;color:var(--ink-faint);background:rgba(0,0,0,.03);border:1px dashed var(--line);border-radius:12px;padding:10px 12px;margin-bottom:14px;line-height:1.5;text-align:center;"
    >
      先在「工坊」完成试看确认，才能邀请爸妈
    </div>

    <!-- 本月成本 -->
    <div class="seg">本月成本</div>
    <div class="cost-card">
      <div class="cost-top">
        <div class="cost-num">{{ usedSeconds }} 秒</div>
        <div class="cost-sep">/</div>
        <div class="cost-unit" style="font-size:14px;color:#4a3f70;font-weight:700;">{{ usedYuan }}</div>
        <div style="margin-left:auto;font-size:10.5px;color:var(--ink-faint);">provider: {{ providerLabel }}</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: pct + '%' }"></div>
      </div>
      <div class="progress-meta">
        <span>已用 {{ usedSeconds }}s</span>
        <span>额度上限 {{ capSeconds }}s/月</span>
      </div>
    </div>

    <!-- 周报占位 -->
    <div class="seg">本周周报</div>
    <div class="weekly-card">
      <div class="wk-header">
        <div class="wk-icon">📊</div>
        <div class="wk-title">本周陪聊摘要</div>
        <div class="wc-badge v1" style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:rgba(139,108,240,.12);color:var(--p1);">V1 上线</div>
      </div>
      <div class="wk-text">周报功能 V1 即将上线，将自动汇总爸妈本周陪聊次数、话题与情绪状态。</div>
      <div class="wk-note">仅显示摘要，看不到聊天内容（隐私保护 R1）</div>
    </div>
    <div style="height:10px;"></div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { regenCode } from '../../api/client.js';

const props = defineProps({
  family:   { type: Object,   default: () => ({}) },
  usage:    { type: Object,   default: () => ({}) },
  provider: { type: String,   default: 'emo' },
  loading:  { type: Boolean,  default: false },
  toast:    { type: Function, required: true },
});

const members = computed(() => props.family?.members || []);
const confirmed = computed(() => !!props.family?.confirmed);

function bound(m) { return !!(m.last_active || m.lastActive); }
function avatarOf(m) { return m.role === 'parent' ? '👵' : '🧑'; }
function nameOf(m)   { return m.nickname || (m.role === 'parent' ? '爸妈' : '我'); }

function statusLine(m) {
  if (!bound(m)) return '待邀请';
  const ts = m.last_active || m.lastActive;
  const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
  if (isNaN(d.getTime())) return '已绑定';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? `今天 ${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  return `已绑定 · 上次活跃：${when}`;
}

// ── 成本 ──
const usedSeconds = computed(() => Math.round(props.usage?.videoSeconds || 0));
const capSeconds  = computed(() => Math.round(props.usage?.capSeconds || 300));
const pct = computed(() => {
  if (!capSeconds.value) return 0;
  return Math.min(100, Math.round((usedSeconds.value / capSeconds.value) * 1000) / 10);
});
// 估价：3:4 约 0.16 元/秒（展示用）
const usedYuan = computed(() => '约 ¥' + (usedSeconds.value * 0.16).toFixed(1));
const providerLabel = computed(() => {
  const p = props.provider || props.usage?.provider || 'emo';
  return String(p).toUpperCase();
});

function inviteUrl(role) {
  const code = role === 'parent'
    ? (memberCode('parent'))
    : (memberCode('child'));
  const base = window.location.origin + window.location.pathname;
  const hash = '#/' + role;
  return `${base}${hash}?code=${encodeURIComponent(code || '')}`;
}

function memberCode(role) {
  const m = members.value.find(x => x.role === role);
  return m ? (m.invite_code || m.inviteCode || '') : '';
}

async function copyInvite(role) {
  const url = inviteUrl(role);
  try {
    await navigator.clipboard.writeText(url);
    props.toast('邀请链接已复制，发微信给爸妈即可', 3000);
  } catch (_) {
    props.toast('链接：' + url, 5000);
  }
}

const emit = defineEmits(['refresh']);

async function onRegen(role) {
  if (!confirm('重新生成爸妈的邀请口令？旧链接将失效')) return;
  try {
    const r = await regenCode(role);
    if (r && r.code) {
      props.toast('新口令已生成：' + r.code, 3500);
      emit('refresh');
    } else if (r && r.error) {
      props.toast(r.error, 4000);
    } else {
      props.toast('该口令由环境变量配置，无法在此更换', 4000);
    }
  } catch (e) {
    props.toast('换口令失败：' + (e.message || e), 3500);
    console.error('[FamilyCost] 换口令失败:', e);
  }
}
</script>
