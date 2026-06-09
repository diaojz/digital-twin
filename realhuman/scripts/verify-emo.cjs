// M0 验证：文生图 → emo-detect-v1(轮询拿bbox) → emo-v1(对口型视频) 全链路
const fs = require('fs'); const path = require('path');
const env = {};
fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split('\n').forEach((l) => {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2].trim();
});
const KEY = env.DASHSCOPE_API_KEY;
const BASE = 'https://dashscope.aliyuncs.com';
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const Hasync = { ...H, 'X-DashScope-Async': 'enable' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(taskId, label, tries = 120, gap = 5000) {
  for (let i = 1; i <= tries; i++) {
    await sleep(gap);
    const r = await fetch(`${BASE}/api/v1/tasks/${taskId}`, { headers: { Authorization: H.Authorization } });
    const j = await r.json(); const st = j.output?.task_status;
    process.stdout.write(`\r  [${label}] ${i}: ${st}        `);
    if (st === 'SUCCEEDED') { console.log(''); return j; }
    if (st === 'FAILED' || st === 'UNKNOWN') { console.log(''); throw new Error(`${label} 失败: ${JSON.stringify(j.output)}`); }
  }
  throw new Error(`${label} 超时`);
}
async function tts(text) {
  const r = await fetch(`${BASE}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST', headers: H, body: JSON.stringify({ model: 'cosyvoice-v2', input: { text, voice: 'longwan_v2' }, parameters: { format: 'mp3', sample_rate: 24000 } }) });
  return (await r.json()).output?.audio?.url;
}
async function t2i() {
  const c = await fetch(`${BASE}/api/v1/services/aigc/text2image/image-synthesis`, {
    method: 'POST', headers: Hasync, body: JSON.stringify({ model: 'wanx2.1-t2i-turbo', input: { prompt: '一位温柔治愈的年轻亚洲女性，正面肖像，清晰五官，柔和自然微笑，简洁柔光纯色背景，写实摄影风格，高质量' }, parameters: { size: '720*1280', n: 1 } }) });
  const d = await poll((await c.json()).output.task_id, '文生图', 40, 3000);
  return d.output?.results?.[0]?.url;
}
async function emoDetect(imageUrl) {
  const c = await fetch(`${BASE}/api/v1/services/aigc/image2video/face-detect`, {
    method: 'POST', headers: Hasync, body: JSON.stringify({ model: 'emo-detect-v1', input: { image_url: imageUrl }, parameters: { ratio: '3:4' } }) });
  const cj = await c.json();
  if (!cj.output?.task_id) { console.log('detect 同步响应:', JSON.stringify(cj).slice(0,400)); return cj.output; }
  const d = await poll(cj.output.task_id, 'emo-detect', 30, 3000);
  return d.output;
}
async function emoGen(imageUrl, audioUrl, det) {
  const input = { image_url: imageUrl, audio_url: audioUrl };
  if (det?.face_bbox) input.face_bbox = det.face_bbox;
  if (det?.ext_bbox) input.ext_bbox = det.ext_bbox;
  const c = await fetch(`${BASE}/api/v1/services/aigc/image2video/video-synthesis/`, {
    method: 'POST', headers: Hasync, body: JSON.stringify({ model: 'emo-v1', input, parameters: { style_level: 'normal' } }) });
  const cj = await c.json();
  if (!cj.output?.task_id) throw new Error('emo-v1 创建失败: ' + JSON.stringify(cj).slice(0, 400));
  console.log('  emo-v1 task:', cj.output.task_id);
  const d = await poll(cj.output.task_id, 'emo-v1', 120, 5000);
  return d.output?.video_url;
}
(async () => {
  try {
    console.log('① CosyVoice…'); const audioUrl = await tts('你来啦，我一直在这儿等你呢，今天还好吗？'); console.log('  ✓', audioUrl.slice(0,70)+'…');
    console.log('② 文生图…'); const imageUrl = await t2i(); console.log('  ✓', imageUrl.slice(0,70)+'…');
    console.log('③ emo-detect-v1…'); const det = await emoDetect(imageUrl); console.log('  ✓ detect:', JSON.stringify(det).slice(0,300));
    console.log('④ emo-v1 生成对口型视频…'); const videoUrl = await emoGen(imageUrl, audioUrl, det);
    console.log('\n========== M0 全链路打通 ✅ ==========');
    console.log('对口型视频:', videoUrl);
  } catch (e) { console.error('\n❌', e.message); process.exit(1); }
})();
