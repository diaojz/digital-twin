#!/usr/bin/env node
/**
 * scripts/test-video-provider.js
 *
 * 三路对口型视频 provider 自测脚本（契约 §7）——「填 key 即测」的唯一入口。
 *
 * 用法：
 *   node scripts/test-video-provider.js                    # 列出全部 provider 配置状态（零网络）
 *   node scripts/test-video-provider.js omnihuman          # 只看某一路的状态 + 开通入口
 *   node scripts/test-video-provider.js omnihuman --real   # key 齐备时跑最小真实链路（会产生费用！）
 *
 * --real 真实链路：读 public/avatars/ 现有形象图 → prepareFigure →
 *   固定短文本走 CosyVoice TTS（需要 DASHSCOPE_API_KEY）→ generateVideo →
 *   视频落盘 /tmp/ 并打印路径与耗时。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── 读取 .env（与 server.js 同款极简解析，process.env 优先）──
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// .env 加载完之后再 import（providers 的 configStatus 读 process.env）
const { providers, getProvider } = await import('../realhuman/providers/index.js');
const { tts } = await import('../realhuman/api.js');

// ── 各 provider 的开通入口（缺 key 时照着开）──────────────────
const PORTALS = {
  emo: [
    '开通入口：',
    '  1. 阿里云百炼控制台 https://bailian.console.aliyun.com → 右上角「API-KEY」→ 创建（华北2-北京）',
    '  2. 模型广场搜「悦动人像」单独申请开通 EMO（没开通时调用报 403）',
    '  3. .env 填 DASHSCOPE_API_KEY=sk-xxx',
    '价格：免费 1800 秒（开通后 90 天内），超出 1:1 画幅 0.08 元/秒、3:4 画幅 0.16 元/秒',
  ],
  wans2v: [
    '开通入口：',
    '  1. 和 emo 共用同一个 DASHSCOPE_API_KEY，零新增配置',
    '  2. 调用报 403 时到百炼模型广场搜「wan2.2-s2v」开通（数字人-万相）',
    '价格：480P 0.5 元/秒 / 720P 0.9 元/秒（WANS2V_RESOLUTION 选），免费 100 秒（90 天内）',
    '限制：音频 <20 秒（约 70 字）；官方耗时 5-10 分钟（短句更快），--real 测试请耐心等',
  ],
  omnihuman: [
    '开通入口：',
    '  1. 火山引擎「即梦AI」能力页 https://console.volcengine.com/ai/ability/detail/2',
    '     → 自助开通「数字人快速模式」 https://console.volcengine.com/ai/ability/info/20012（需账号实名认证）',
    '  2. 控制台右上角头像 → 「API访问密钥」→ 创建 AK/SK',
    '  3. .env 填 VOLC_ACCESS_KEY_ID / VOLC_SECRET_ACCESS_KEY',
    '价格：⚠️ 约 1 元/秒（10 秒视频约 10 元），输出 480P，并发限额 1',
  ],
  seedance: [
    '开通入口：',
    '  1. 火山方舟控制台 https://console.volcengine.com/ark → 「开通管理」→ 开通 doubao-seedance-2-0-260128',
    '  2. 「API Key 管理」→ 创建 API Key',
    '  3. .env 填 ARK_API_KEY（SEEDANCE_MODEL 可保持默认 doubao-seedance-2-0-260128）',
    '价格：⚠️ 720p 约 1 元/秒（fast 版约 0.8 元/秒）',
  ],
};

function printStatus(p) {
  const { ready, missing } = p.configStatus();
  console.log(`\n■ ${p.displayName}（id: ${p.id}）`);
  if (ready) {
    console.log('  ✅ key 已配置，可加 --real 跑真实链路（会产生费用）');
  } else {
    console.log(`  ⚠️ 缺 env 键：${missing.join(' / ')}`);
    for (const line of PORTALS[p.id] || []) console.log(`  ${line}`);
  }
}

// ── 参数解析 ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const real = args.includes('--real');
const id = args.find(a => !a.startsWith('--'));

if (id && !providers[id]) {
  console.error(`未知 provider: ${id}（可选 ${Object.keys(providers).join(' / ')}）`);
  process.exit(1);
}

// ── 模式 1：零网络自检 ───────────────────────────────────────
if (!real) {
  console.log('对口型视频 provider 配置自检（零网络请求）');
  console.log(`当前 VIDEO_PROVIDER=${process.env.VIDEO_PROVIDER || 'emo（默认）'}`);
  const list = id ? [getProvider(id)] : Object.values(providers);
  for (const p of list) printStatus(p);
  console.log('\n跑真实链路：node scripts/test-video-provider.js <emo|omnihuman|seedance> --real');
  process.exit(0);
}

// ── 模式 2：--real 最小真实链路 ──────────────────────────────
if (!id) {
  console.error('--real 必须指定 provider：node scripts/test-video-provider.js <emo|omnihuman|seedance> --real');
  process.exit(1);
}

const provider = getProvider(id);
const { ready, missing } = provider.configStatus();
if (!ready) {
  console.error(`${provider.displayName} 未配置：缺 ${missing.join(' / ')}`);
  for (const line of PORTALS[id] || []) console.error(line);
  process.exit(1);
}
// 三路的测试音频都来自 CosyVoice（与正式 speak 链路一致），所以 TTS 需要百炼 key
if (!process.env.DASHSCOPE_API_KEY) {
  console.error('TTS 需要 DASHSCOPE_API_KEY（测试音频走 CosyVoice，与正式链路一致），请先在 .env 配置');
  process.exit(1);
}

// 形象图：本地源文件是唯一真相（契约 §3.4），按 rhFigure.source 优先选
const AVATAR_DIR = join(ROOT, 'public', 'avatars');
const UPLOAD_IMG = join(AVATAR_DIR, 'current-upload.jpg');   // 上传照片
const GEN_IMG = join(AVATAR_DIR, 'current.png');             // 文生图
let source = null;
try {
  const fig = JSON.parse(readFileSync(join(ROOT, 'data', 'realhuman-figure.json'), 'utf-8'));
  source = fig?.source || null;
} catch (_) { /* 没有 figure 缓存文件就按存在性兜底 */ }

let imagePath, mime;
const preferUpload = source === 'upload';
const candidates = preferUpload
  ? [[UPLOAD_IMG, 'image/jpeg'], [GEN_IMG, 'image/png']]
  : [[GEN_IMG, 'image/png'], [UPLOAD_IMG, 'image/jpeg']];
for (const [p, m] of candidates) {
  if (existsSync(p)) { imagePath = p; mime = m; break; }
}
if (!imagePath) {
  console.error('public/avatars/ 下没有形象图（current.png / current-upload.jpg）。');
  console.error('请先 npm start → 设置 → 形象图片，生成形象或上传照片，再来跑本脚本。');
  process.exit(1);
}

const TEST_TEXT = '你好，我是小忆，这是一条对口型测试视频。';
console.log(`■ 真实链路测试：${provider.displayName}（id: ${id}）`);
console.log(`  形象图：${imagePath}`);
console.log(`  测试文本：「${TEST_TEXT}」`);
console.log('  ⚠️ 本次运行会真实计费（EMO 0.08~0.16 元/秒；OmniHuman/Seedance 约 1 元/秒）\n');

const imageBuffer = readFileSync(imagePath);
const tTotal = Date.now();

try {
  // 1. 形象预处理
  let t = Date.now();
  console.log('[1/4] prepareFigure（形象预处理）...');
  const { meta } = await provider.prepareFigure({ imageBuffer, mime, ratio: '3:4' });
  console.log(`      完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);
  if (meta.checkPass === false && meta.detectError) {
    console.warn(`      ⚠️ 质量检查未通过：${meta.detectError}（继续尝试生成，可能失败）`);
  }

  // 2. TTS 出公网音频 URL
  t = Date.now();
  console.log('[2/4] TTS（CosyVoice 合成测试音频）...');
  const audioUrl = await tts(TEST_TEXT);
  console.log(`      完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);

  // 3. 对口型视频生成（含 provider 内部上传/轮询，可能要等几分钟）
  t = Date.now();
  console.log('[3/4] generateVideo（云端生成对口型视频，耐心等几十秒到几分钟）...');
  const { videoUrl, videoBuffer } = await provider.generateVideo({
    imageBuffer, mime, meta, audioUrl, text: TEST_TEXT,
  });
  console.log(`      完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);

  // 4. 落盘 /tmp/
  t = Date.now();
  console.log('[4/4] 下载视频落盘 /tmp/ ...');
  const outPath = join('/tmp', `test-video-${id}-${Date.now()}.mp4`);
  let buf = videoBuffer;
  if (!buf) {
    const resp = await fetch(videoUrl);
    if (!resp.ok) throw new Error(`下载视频失败 HTTP ${resp.status}（远端 URL 有时效，过期需重跑）`);
    buf = Buffer.from(await resp.arrayBuffer());
  }
  writeFileSync(outPath, buf);
  console.log(`      完成（${((Date.now() - t) / 1000).toFixed(1)}s）`);

  console.log(`\n✅ ${provider.displayName} 链路打通！`);
  console.log(`   视频文件：${outPath}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`   总耗时：${((Date.now() - tTotal) / 1000).toFixed(1)}s`);
  console.log(`   播放：open ${outPath}`);
} catch (e) {
  console.error(`\n❌ ${provider.displayName} 链路失败：${e.message}`);
  console.error('   排查：先看上面失败在哪一步；key/开通问题对照下面入口——');
  for (const line of PORTALS[id] || []) console.error(`   ${line}`);
  process.exit(1);
}
