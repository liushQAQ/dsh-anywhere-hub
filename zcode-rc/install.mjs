#!/usr/bin/env node
/**
 * zcode-rc-gateway 一键部署（v25）
 *
 * 用途：把这套「手机打开 ZCode 桌面端远程页」的网关拷到任意目录，并打印后续两条命令。
 * 不做的事：不改 ZCode 任何文件、不写注册表、不自动建计划任务（除显式 --task）。
 *
 * 用法：
 *   node install.mjs --target D:\zcode-rc\zcode-rc-gateway-3090
 *   node install.mjs --target D:\zcode-rc\zcode-rc-gateway-3090 --task --port 3090
 *
 * 产物结构（runner.mjs 第 3 顺位自动找到 ./lib/proxy.mjs，无需改任何路径）：
 *   <target>/runner.mjs
 *   <target>/mobilefix.js
 *   <target>/diag.html
 *   <target>/lib/proxy.mjs
 */

import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

const target = resolve(arg('target', ''));
const port = arg('port', '3090');
const wantTask = arg('task', '') === 'true';

if (!target || target === resolve('.')) {
  console.error('缺少 --target <目标目录>，例：node install.mjs --target D:\\zcode-rc\\zcode-rc-gateway-3090');
  process.exit(2);
}

/** proxy.mjs 的候选位置：安装包自带 > 同级 packages 分区（目录名唯一 dsh-anywhere-hub，无裸名） */
const proxyCandidates = [
  join(HERE, 'lib', 'proxy.mjs'),
  join(HERE, '..', 'packages', 'dsh-anywhere-hub', 'lib', 'proxy.mjs'),
  join(HERE, '..', 'node_modules', 'dsh-anywhere-hub', 'lib', 'proxy.mjs'),
  join(HERE, '..', 'dsh-anywhere-hub', 'lib', 'proxy.mjs'),
  join(HERE, '..', 'lib', 'proxy.mjs'),   // 从 dsh-anywhere-hub 仓库的 zcode-rc/ 直接跑
];

const files = [
  { name: 'runner.mjs', src: join(HERE, 'runner.mjs') },
  { name: 'mobilefix.js', src: join(HERE, 'mobilefix.js') },
  { name: 'diag.html', src: join(HERE, 'diag.html') },
];

console.log('== zcode-rc-gateway 安装 ==');
console.log('源目录：' + HERE);
console.log('目标  ：' + target);

for (const f of files) {
  if (!existsSync(f.src)) {
    console.error('✗ 缺少源文件：' + f.src);
    process.exit(3);
  }
}

const proxySrc = proxyCandidates.find((p) => existsSync(p));
if (!proxySrc) {
  console.error('✗ 找不到 lib/proxy.mjs。');
  console.error('  请把 dsh-anywhere-hub 的 lib/proxy.mjs 放到下面任一位置后重跑：');
  for (const p of proxyCandidates) console.error('    ' + p);
  process.exit(4);
}

mkdirSync(join(target, 'lib'), { recursive: true });

for (const f of files) {
  const dst = join(target, f.name);
  copyFileSync(f.src, dst);
  console.log('✓ ' + f.name.padEnd(14) + (statSync(dst).size / 1024).toFixed(1) + ' KB');
}

const proxyDst = join(target, 'lib', 'proxy.mjs');
copyFileSync(proxySrc, proxyDst);
console.log('✓ lib/proxy.mjs   ' + (statSync(proxyDst).size / 1024 / 1024).toFixed(2) + ' MB');

// 校验：proxy.mjs 必须是带 ZCode 改造的那份，原版会让 iOS 16.3 卡启动壳
const proxyText = readFileSync(proxyDst, 'utf8');
const marks = ['ZCODE_RC_ASSET_VER', 'zcodeRcRewriteHtml', 'zcodeRcCapabilitySnapshotHtml'];
const missing = marks.filter((m) => proxyText.indexOf(m) < 0);
if (missing.length) {
  console.error('✗ 这份 proxy.mjs 不是带 ZCode 改造的版本（缺 ' + missing.join(', ') + '）');
  console.error('  官方 DSH 安装包里的原版没有这套改造，iOS 16.3 会卡在启动壳。');
  process.exit(5);
}
const ver = (proxyText.match(/ZCODE_RC_ASSET_VER\s*=\s*'([^']+)'/) || [])[1] || '?';
console.log('✓ 改写管线校验通过（ZCODE_RC_ASSET_VER=' + ver + '）');

console.log('\n== 还差两步 ==');
console.log('\n1) 让 ZCode 桌面端的二维码指向本网关（设完必须完全退出并重启 ZCode）：');
console.log('   setx ZCODE_WEB_REMOTE_CONTROL_URL "http://<你的电脑IP>:' + port + '/remote/v4"');

console.log('\n2) 启动网关：');
console.log('   node "' + join(target, 'runner.mjs') + '"');
console.log('   看到 listening 0.0.0.0:' + port + ' 即成功；手机打开 http://<你的电脑IP>:' + port + '/rc');

if (wantTask) {
  const nodeExe = process.execPath;
  const taskName = 'ZcodeRcGateway-' + port;
  const ps = [
    '$dir = ' + JSON.stringify(target),
    '$act = New-ScheduledTaskAction -Execute ' + JSON.stringify(nodeExe) + ' -Argument ' + JSON.stringify('"' + join(target, 'runner.mjs') + '"') + ' -WorkingDirectory $dir',
    '$trg = New-ScheduledTaskTrigger -AtLogOn',
    '$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden',
    '$pri = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType S4U -RunLevel Highest',
    'Register-ScheduledTask -TaskName ' + JSON.stringify(taskName) + ' -Action $act -Trigger $trg -Settings $set -Principal $pri -Force | Out-Null',
    'Start-ScheduledTask -TaskName ' + JSON.stringify(taskName),
    'Get-NetTCPConnection -LocalPort ' + port + ' -State Listen | Select-Object LocalAddress,LocalPort,State',
  ].join('; ');
  console.log('\n3) 注册开机自启（' + taskName + '）…');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    console.log(out.trim() || '✓ 已注册并启动');
  } catch (e) {
    console.error('✗ 计划任务注册失败：' + (e.stderr || e.message));
    console.error('  可手动执行 README 第四节那条 PowerShell。');
  }
} else {
  console.log('\n（要开机自启：重跑并加 --task，或照 README 第四节的 PowerShell 手动注册）');
}

console.log('\n日志：' + join(target, 'logs', 'service.log'));
console.log('自检：http://<你的电脑IP>:' + port + '/diag');
