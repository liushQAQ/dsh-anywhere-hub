// ZCode 手机远程控制网关（独立端口 3090）—— 2026-11-01 老总拍板与 DSH 3083 解耦。
// 复用 dsh-anywhere-hub 的改写管线（iOS 16.3 语法降级 + polyfill + ETag 破冰 + 中继 WS 隧道），
// allowedPaths 锁死作用域：仅放行 ZCode 远程页相关路径，不暴露 DSH web。
// 自启：计划任务 ZcodeRcGateway-3090（S4U + Hidden）；登记：port-manager/services-config.json。
'use strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { appendFileSync, statSync, renameSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

// ============================================================
// v24（2026-11-07）：路径全部改为「相对本文件自动推导」，可整套复制给别人用。
//   旧版 6 处硬编码（E:/desktop/所有skill/... 与 C:/Users/Administrator/.zcode/...）
//   换机器/换用户名就必须逐行改，无法交接。
//   本机推导结果与旧硬编码**完全一致**（见下方 fallback 注释），行为零变化。
//   可用环境变量覆盖：ZCODE_RC_PROXY / ZCODE_RC_LOG / ZCODE_HOME。
// ============================================================
const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));   // .../zcode-rc-gateway-3090
const SKILL_ROOT = resolve(GATEWAY_DIR, '..');                  // .../所有skill（本机即旧硬编码根）
const ZCODE_HOME = process.env.ZCODE_HOME && process.env.ZCODE_HOME.trim()
  ? resolve(process.env.ZCODE_HOME.trim())
  : join(os.homedir(), '.zcode', 'v2');                         // 本机 = C:/Users/Administrator/.zcode/v2

function firstExisting(list, fallback) {
  for (const p of list) { try { if (existsSync(p)) return p; } catch { /* ignore */ } }
  return fallback;
}

// ① dsh-anywhere-hub 改写管线（纯 Node 内置依赖，不需要 DSH 运行时）
const PROXY_MJS = firstExisting([
  process.env.ZCODE_RC_PROXY || '',
  join(SKILL_ROOT, 'packages', 'dsh-anywhere-hub', 'lib', 'proxy.mjs'), // 本机 = E:/desktop/所有skill/packages/dsh-anywhere-hub
  join(GATEWAY_DIR, 'lib', 'proxy.mjs'),                             // 别人：把 proxy.mjs 放在网关目录下即可
  join(GATEWAY_DIR, '..', 'lib', 'proxy.mjs'),                       // 从 dsh-anywhere-hub 仓库的 zcode-rc/ 直接跑
], join(SKILL_ROOT, 'packages', 'dsh-anywhere-hub', 'lib', 'proxy.mjs'));

const PORT = Number(process.env.ZCODE_RC_PORT || 3090);
// ② 日志：本机沿用集中 logs/ 分区；别人自动落自己目录下
const LOG_DIR = existsSync(join(SKILL_ROOT, 'logs', 'zcode-rc-gateway-3090'))
  ? join(SKILL_ROOT, 'logs', 'zcode-rc-gateway-3090')   // 本机 = E:/desktop/所有skill/logs/zcode-rc-gateway-3090
  : join(GATEWAY_DIR, 'logs');                          // 别人 = <网关目录>/logs
const LOG_PATH = process.env.ZCODE_RC_LOG || join(LOG_DIR, 'service.log');
const LOG_MAX = 2 * 1024 * 1024;

function log(s) {
  try {
    if (!existsSync(dirname(LOG_PATH))) mkdirSync(dirname(LOG_PATH), { recursive: true });
    try { if (statSync(LOG_PATH).size > LOG_MAX) renameSync(LOG_PATH, LOG_PATH + '.old'); } catch { /* 忽略 */ }
    appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + s + '\n');
  } catch { /* 忽略 */ }
}

  const { createPocketProxy } = await import(pathToFileURL(PROXY_MJS).href);

  // ============================================================
  // v9（2026-11-06）：免登录自动注入 —— 老总令「打开即用，不要登陆」。
  // 桌面端 ~/.zcode/v2/credentials.json 与手机页共用同一套 localStorage 键名
  // （oauth:zai:access_token / zcodejwttoken / oauth:zai:user_info / oauth:active_provider，
  // 实锤于官方页 index-Dwhx77cK.js），解密后经 /zcode-rc-api/__auth 下发，
  // 页面 <head> 注入同步 XHR 播种脚本（先于 SPA 求值），登录框从此不再出现。
  // 另附「配对记忆」：带 sid 的链接路过即记住，裸 /remote/v4 自动补参跳转。
  // 🔴 凭证只随 __auth 下发，绝不写日志。
  // ============================================================
  const crypto = await import('node:crypto');
  const CREDS_PATH = join(ZCODE_HOME, 'credentials.json');   // 本机 = C:/Users/Administrator/.zcode/v2/credentials.json
  const LAST_PAIR_PATH = join(GATEWAY_DIR, 'last-pair.json');

  // ============================================================
  // v11（2026-11-07 老总真机反馈）：手机端适配补丁。
  //  ① 顶/底安全区：容器把整屏交给页面，顶栏（含「返回任务首页」按钮 y=10..34）
  //     正藏在状态栏下面 → 看起来整页溢出、返回点不动。按原生 __dshSafeArea /
  //     env(safe-area-inset-*) 给应用外壳补内边距；容器已让出安全区时不叠加。
  //  ② 左缘右滑 = 返回（原生侧滑被 WKWebView 关掉了，这里在页面内补同语义手势）。
  //  ③ 免登录注入成功时隐藏「登录回调」悬浮桥（它压住发送键）；未成功则保留。
  //  脚本独立成文件，改 mobilefix.js 无需动本文件；本文件只负责读入并内联注入。
  // ============================================================
  const MOBILE_FIX_PATH = join(GATEWAY_DIR, 'mobilefix.js');
  const DIAG_HTML_PATH = join(GATEWAY_DIR, 'diag.html');
  let MOBILE_FIX = '';
  let MOBILE_FIX_MTIME = 0;
  // v12：按 mtime 热读，改 mobilefix.js 不必重启网关（真机调试少一轮等待）。
  function readMobileFix() {
    try {
      const st = statSync(MOBILE_FIX_PATH);
      if (st.mtimeMs !== MOBILE_FIX_MTIME) {
        MOBILE_FIX = readFileSync(MOBILE_FIX_PATH, 'utf8');
        MOBILE_FIX_MTIME = st.mtimeMs;
      }
    } catch { if (!MOBILE_FIX) log('zcode-rc: mobilefix.js 读取失败，跳过手机适配补丁'); }
    return MOBILE_FIX;
  }
  readMobileFix();

  let credsCache = { at: 0, data: null };
  function resolveCredSecret() {
    const envSecret = process.env.ZCODE_CREDENTIAL_SECRET;
    if (envSecret && envSecret.trim()) return envSecret.trim();
    let user = 'unknown';
    try { user = os.userInfo().username; } catch { /* ignore */ }
    return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${user}`;
  }
  function decEncV1(payload, key) {
    if (!payload.startsWith('enc:v1:')) return payload;
    const parts = payload.slice(7).split('.');
    if (parts.length !== 3) throw new Error('bad ciphertext');
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  function loadCreds() {
    const now = Date.now();
    if (credsCache.data && now - credsCache.at < 300000) return credsCache.data;
    const key = crypto.createHash('sha256').update(resolveCredSecret()).digest();
    const raw = JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
    const pick = (k) => { try { return decEncV1(String(raw[k] ?? ''), key); } catch { return null; } };
    const data = {
      zai: pick('oauth:zai:access_token') || null,
      zcodeJwt: pick('zcodejwttoken') || null,
      userInfo: pick('oauth:zai:user_info') || null,
      activeProvider: pick('oauth:active_provider') || 'zai',
    };
    if (data.zai && data.zcodeJwt) credsCache = { at: now, data };
    return data;
  }
  const SETTING_PATH = join(ZCODE_HOME, 'setting.json');      // 本机 = C:/Users/Administrator/.zcode/v2/setting.json
  function loadLastPair() {
    // 两个来源，取**较新的那个**（v22，2026-11-07）：
    //  ① last-pair.json —— QR 链接路过学到的 sid+mid+name（带 at 时间戳）
    //  ② setting.json  —— 桌面端持久设备注册 deviceSid（文件 mtime 即注册时刻）
    // 旧版固定「① 优先」有隐患：ZCode 重启/重新注册后 deviceSid 变了，而 ① 还留着旧 sid，
    // 于是 /rc 会 302 到一个已失效的会话。改成比时间后，谁新用谁，重启后自动跟上。
    let pair = null;
    try {
      const p = JSON.parse(readFileSync(LAST_PAIR_PATH, 'utf8'));
      if (p && p.sid) pair = p;
    } catch { /* ignore */ }
    let dev = null;
    try {
      const setting = JSON.parse(readFileSync(SETTING_PATH, 'utf8'));
      const d = setting && setting.webRemoteControlRelayV2Device;
      if (d && d.deviceSid) dev = { sid: d.deviceSid, mid: '', name: 'ZCode Desktop', src: 'setting.json' };
    } catch { /* ignore */ }

    if (pair && dev) {
      if (pair.sid === dev.sid) return pair;          // 同一会话：① 的 mid/name 更全
      let atMs = 0;
      try { atMs = Date.parse(pair.at) || 0; } catch { atMs = 0; }
      if (!atMs) { try { atMs = statSync(LAST_PAIR_PATH).mtimeMs; } catch { atMs = 0; } }
      let devMs = 0;
      try { devMs = statSync(SETTING_PATH).mtimeMs; } catch { devMs = 0; }
      if (devMs > atMs) return dev;                    // 桌面端注册更新 → 用新 sid
      return pair;                                     // 二维码链路更新 → 用 ①
    }
    return pair || dev;
  }
  function saveLastPair(p) {
    try { writeFileSync(LAST_PAIR_PATH, JSON.stringify(p, null, 1), 'utf8'); } catch { /* ignore */ }
  }

  const zcodeRcHook = {
    // 真机诊断信标（v13）：mobilefix.js 每页回传一条 diag，直接落网关日志。
    // 没有这个端点时信标会被代理到上游 404，等于瞎跑 —— 这是 v12 现场取不到证的原因。
    // v14（2026-11-07）：访问留痕。手机若连页面都跑不起来（白屏/报错页），
    // BEACON 一条都不会有 → 分不清「没连上网关」还是「页面炸了」。这里把每个
    // 页面级请求（HTML / API / 未知路径）连同 UA 落日志：能查到 = 网络通、问题在页面；
    // 查不到 = 根本没到网关（换网/Tailscale/地址错）。静态资源不记，避免刷屏。
    intercept(req, res, u) {
      // v15（2026-11-07）：两台手机 UA 都是 App 写死的 iPhone OS 12_0，靠 UA 分不清谁是谁，
      // 只有客户端 IP 能区分 → 每条 REQ / BEACON 都带 ip，以后「哪台没连上」一眼可判。
      const ip = (() => {
        try {
          const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
          return xff || String(req.socket?.remoteAddress || '-');
        } catch { return '-'; }
      })();
      try {
        const p = u ? u.pathname : String(req.url || '');
        const ua = String(req.headers['user-agent'] || '');
        // v19（2026-11-07）：补上「静态资源盲区」。
        // 旧版只记 HTML/API，assets 一律不记 → 若那台 16.3 手机命中的是**旧文档**
        // （HTML 来自缓存、bundle 走网络），它的请求全落在 /assets/ 上，日志里一条都看不见，
        // 于是「手机到底有没有到网关」永远判不了。现在 iPhone UA 的资源请求也记一行 AST，
        // 非 iPhone（本机 curl / 自动化）仍不记，避免刷屏。
        const isIPhone = /iPhone|iPad|iPod/i.test(ua);
        if (p !== '/zcode-rc-api/__beacon' && (p.indexOf('/assets/') < 0 || isIPhone)) {
          log(`REQ ip=${ip} ${req.method} ${p.slice(0, 80)}${(u && u.search ? u.search.slice(0, 60) : '')} ua=${ua.slice(0, 72)}`);
        }
      } catch { /* ignore */ }
      // v16（2026-11-07）：/rc 缓存逃生口。
      // 现场问题：16.3 那台手机的 WKWebView 把旧文档/旧 bundle 钉死在缓存里，
      // 打开同一个 URL 一条请求都不发（日志里连 REQ 都没有），网关这边改什么都到不了它。
      // App 的缓存键是完整 URL，所以只要换一个从没被缓存过的 URL 就能破局。
      // /rc 每次访问都用当前配对 + 时间戳拼一个新地址 302 过去 → 天然 cache miss。
      // 页面本身（v15 起）已经 no-store + 资源带 ?v=，只要拿到一次新文档就永久新鲜。
      // v20（2026-11-07）：短别名 /r、/d —— 手机上手打 局域网IP/r 比 :端口/rc 省一半字符。
      if (u && (u.pathname === '/r' || u.pathname === '/r/')) u.pathname = '/rc';
      if (u && (u.pathname === '/d' || u.pathname === '/d/')) u.pathname = '/diag';
      // v23（2026-11-07）：老地址自愈。
      // 旧书签 /remote/v4?sid=… 被标过 immutable 一年，缓存命中时连请求都不发 —— 服务端修不到。
      // 但只要它的缓存**失效**（iOS 回收 / 手动清 / 换设备 / 一年到期），下一次请求一定会到网关；
      // 那一刻必须直接把它弹到 /rc（全新地址），而不是再吐一份旧文档让它重新钉死。
      // 只匹配「文档导航」：路径精确 /remote/v4 或 /remote/v4/ + Accept 含 text/html + 无 _zcrc。
      // 资源 /remote/v4/3.17.2/assets/… 与 API /remote/v4/api/… 路径不精确匹配，完全不受影响。
      // v26（2026-11-07）：带 mid 的链接一律放行 —— 那是桌面端刚生成的「首次配对邀请」。
      //   旧规则会把它也弹到 /rc，而新机器此刻还没有 last-pair.json，/rc 只能回落到
      //   setting.json 的 deviceSid（mid 为空）→ 邀请被丢掉 → 手机页面能开但永远连不上中继。
      //   放行后页面脚本会调 /zcode-rc-api/__auth 把 sid+mid 记进 last-pair.json，之后 /rc 才完整。
      if (u && (u.pathname === '/remote/v4' || u.pathname === '/remote/v4/')
          && !u.searchParams.get('_zcrc')
          && !u.searchParams.get('mid')
          && /text\/html/i.test(String(req.headers.accept || ''))) {
        log('zcode-rc: 老地址自愈 → /rc (ip=' + ip + ')');
        res.writeHead(302, { location: '/rc', 'cache-control': 'no-store, no-cache, must-revalidate' });
        res.end();
        return true;
      }
      if (u && (u.pathname === '/rc' || u.pathname === '/rc/' || u.pathname.startsWith('/rc/'))) {
        const pair = loadLastPair();
        if (!pair || !pair.sid) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('还没有配对信息：先在桌面端生成一次远程二维码，或直接打开带 sid 的完整地址。');
          return true;
        }
        const q = new URLSearchParams({
          sid: pair.sid,
          mid: pair.mid || '',
          name: pair.name || 'iPhone',
          app_version: '3.17.2',
          _zcrc: String(Date.now()),
        });
        // v26（2026-11-07）：mid 为空 = 还没扫码配对。这时硬进正式页只会「页面能开、中继永远连不上」，
        // 用户看不出原因。改送 /diag，那一页会明确写「还没配对（缺 mid），先扫桌面端二维码」。
        if (!pair.mid) {
          log('zcode-rc: /rc 缺 mid → /diag 提示扫码 (ip=' + ip + ')');
          res.writeHead(302, { location: '/diag?' + q.toString(), 'cache-control': 'no-store' });
          res.end();
          return true;
        }
        const loc = '/remote/v4?' + q.toString();
        log('zcode-rc: /rc → 302 ' + loc.slice(0, 90) + ' (ip=' + ip + ')');
        res.writeHead(302, { location: loc, 'cache-control': 'no-store, no-cache, must-revalidate' });
        res.end();
        return true;
      }
      if (u && (u.pathname === '/diag' || u.pathname === '/diag/')) {
        // v17（2026-11-07）：纯 ES5 自检页 —— 不依赖主程序、不依赖任何垫片，
        // 只要能显示文字就证明「网关通 + WebView 正常」，卡在启动壳时用来分责任方。
        // 没有配对参数时先补上（与 /rc 同源），页面才能直接给出正式页入口。
        let q = u.searchParams;
        if (!q.get('sid')) {
          const pair = loadLastPair();
          if (pair && pair.sid) {
            const loc = '/diag?' + new URLSearchParams({
              sid: pair.sid,
              mid: pair.mid || '',
              name: pair.name || 'iPhone',
              app_version: '3.17.2',
              _zcrc: String(Date.now()),
            }).toString();
            res.writeHead(302, { location: loc, 'cache-control': 'no-store' });
            res.end();
            return true;
          }
        }
        let html = '';
        try { html = readFileSync(DIAG_HTML_PATH, 'utf8'); } catch { /* 见下 */ }
        if (!html) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('diag.html 读取失败');
          return true;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
          pragma: 'no-cache',
        });
        res.end(html);
        return true;
      }
      if (u && u.pathname === '/zcode-rc-api/__beacon') {
        try {
          const m = (u.searchParams.get('m') || '').slice(0, 400);
          if (m && m !== 'ping') log('BEACON ip=' + ip + ' ' + m);
        } catch { /* ignore */ }
        res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
        res.end();
        return true;
      }
      // 本地凭证端点：GET /zcode-rc-api/__auth[?sid=..&mid=..&name=..]
      if (!u || u.pathname !== '/zcode-rc-api/__auth') return false;
      try {
        const sid = u.searchParams.get('sid') || '';
        const mid = u.searchParams.get('mid') || '';
        const name = u.searchParams.get('name') || '';
        if (sid && mid && sid.length <= 128 && mid.length <= 128) {
          const prev = loadLastPair();
          if (!prev || prev.sid !== sid || prev.mid !== mid) {
            saveLastPair({ sid, mid, name: name.slice(0, 60), at: new Date().toISOString() });
            log('zcode-rc: last-pair 更新 sid=' + sid.slice(0, 8) + '…');
          }
        }
        const c = loadCreds();
        const body = JSON.stringify({
          zai: c.zai || null,
          zcodeJwt: c.zcodeJwt || null,
          userInfo: c.userInfo || null,
          activeProvider: c.activeProvider || 'zai',
          lastPair: loadLastPair(),
        });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'cred-unavailable' }));
        log('zcode-rc: __auth 失败 ' + (e && e.message));
      }
      return true;
    },
    // 页面头部注入：同步 XHR 播种（同步保证先于 SPA 模块求值）+ 裸地址补配对参数
    htmlInject() {
      const autologin = `<script data-zcode-rc-autologin="1">(function(){try{var q=location.search&&location.search.substring(1);var x=new XMLHttpRequest();x.open('GET','/zcode-rc-api/__auth'+(q?('?'+q):''),false);x.send(null);if(x.status===200){var j=JSON.parse(x.responseText);try{if(j.zai)localStorage.setItem('oauth:zai:access_token',j.zai)}catch(e){}try{if(j.zcodeJwt)localStorage.setItem('zcodejwttoken',j.zcodeJwt)}catch(e){}try{if(j.userInfo)localStorage.setItem('oauth:zai:user_info',j.userInfo)}catch(e){}try{if(j.activeProvider)localStorage.setItem('oauth:active_provider',j.activeProvider)}catch(e){}try{if(j.zai&&j.zcodeJwt)window.__zcrcAutologin=1}catch(e){}if(!/[?&]sid=/.test(location.search)&&j.lastPair&&j.lastPair.sid){location.replace('/remote/v4?sid='+encodeURIComponent(j.lastPair.sid)+'&mid='+encodeURIComponent(j.lastPair.mid||'')+'&name='+encodeURIComponent(j.lastPair.name||'')+'&_zcrc='+Date.now())}}}catch(e){}})();</script>`;
      // v18（2026-11-07）：Safari「添加到主屏幕」全屏化。
      // App 那条路被旧缓存钉死时，16.3 手机改用 Safari 直接开同一个地址即可（同一套
      // 语法降级 + 垫片，真 WebKit 已验证可渲染）；补这三条 meta 后从主屏图标进入
      // 就没有地址栏和底部工具栏，视觉上与 App 一致。对 App 内 WebView 无副作用。
      const a2hs = '<meta name="apple-mobile-web-app-capable" content="yes">'
        + '<meta name="mobile-web-app-capable" content="yes">'
        + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
        + '<meta name="apple-mobile-web-app-title" content="DSH">';
      const FIX = readMobileFix();
      if (!FIX) return autologin + a2hs;
      return autologin + a2hs
        + '<style data-zcrc-mobilefix="1">:root{--zcrc-sb-top:0px;--zcrc-sb-bottom:0px}'
        + '#root>div[class*="h-dvh"]{box-sizing:border-box;padding-top:var(--zcrc-sb-top,0px);padding-bottom:var(--zcrc-sb-bottom,0px)}</style>'
        + `<script data-zcrc-mobilefix="2">${FIX}</script>`;
    },
    // v12（2026-11-07）：服务端把页面 viewport 补成 viewport-fit=cover，
    // 否则页面自己写的 viewport 没这个键，env(safe-area-inset-*) 永远返回 0，
    // 安全区只能靠容器下发（老容器不下发 → 顶栏压在状态栏下、输入框压在 Home 条上）。
    viewportFitCover: true,
    // v15（2026-11-07）：本实例的 JS 不再发 immutable（见 proxy.mjs ZCODE_RC_ASSET_VER 注释）。
    // 老设备缓存里的旧 bundle 是「16.3 卡启动壳」最可能的帮凶：缓存命中时连请求都不发，
    // 网关这边的语法降级根本到不了手机。3083 不设这个开关，保持原策略。
    freshAssets: true,
  };

// v19（2026-11-07）：双源站。
// 现场只剩一个没被排除的变量：那台 16.3 手机的 WebView 可能是**按源站**（scheme+host+port）
// 而不是按完整 URL 建缓存/建离线副本，那么换路径 /rc、换查询串都白搭 —— 它连请求都不发。
// 换端口 = 换源站，任何按源站建键的缓存/存储/离线副本一律失效。3091 与 3090 是同一份
// 代码、同一套改写与垫片，只是 origin 不同；3083 完全不受影响。
// v20（2026-11-07）：再加一条「无端口」源站 —— 80。
// 手机上手打 局域网IP/r 即可，且 origin 变成 http://局域网IP（无端口），
// 任何按源站建键的 HTTP 缓存 / WKWebView 离线副本 / IndexedDB 一律全新，一次就干净。
// 80 被占用时该条会 startup failed，其余端口照常工作（下面 try/catch 已保证）。
const PORTS = [PORT, 3091, 80];
let started = 0;
for (const p of PORTS) {
  try {
    const inst = await createPocketProxy({
      port: p,
      host: '0.0.0.0',
      log: (s) => log(s),
      zcodeRcHook, // v9 免登录注入 + 配对记忆（见上）
      injectHtml: '', // 本实例不服务 DSH web，注入闸关闭
      // v8：/api/ 必须放行 —— SPA 原生 OAuth 换 token 用相对路径 `/api/v1/oauth/token`，
      // 被作用域闸挡掉就永远拿不到登录态（表现为登录成功后 splash 转圈 + relay 401）。
      allowedPaths: ['/remote', '/rc', '/r', '/diag', '/d', '/zcode-rc-api/', '/api/', '/web-remote', '/web-remote/'],
      upstream: { host: '127.0.0.1', port: 59999 }, // 作用域闸之下永远走不到，占位即可
    });
    started += 1;
    log(`listening 0.0.0.0:${inst.port} (zcode-rc-gateway, allowedPaths locked)`);
  } catch (err) {
    log(`startup failed on :${p} — ${err.message}`);
  }
}
// 主端口起不来才退出（端口被占=重复拉起，静默让位）；备端口失败不影响主链路。
if (!started) process.exit(0);
