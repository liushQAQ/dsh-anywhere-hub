/* dsh-anywhere-hub · DSH 会话框「键盘跟手」补丁（kbglide v5，2026-11-09）
   ─────────────────────────────────────────────────────────────────────
   目标：在 DSH 网页（3083）里点会话框，输入区跟着键盘一起平滑上滑/回落，
        不再「啪」地整块跳 300px。

   为什么前两版都不行（实测，不是推测）：
     v3：只在 resize 里「看到跳变才补」。App 152 的协议是「先在合成层上滑、
         键盘落定后再一次性改 WebView 高度」，resize 那一刻布局已到终点，
         pin 算出来 0 —— 实测 OPEN 790 → 490 单帧 300px、pins=0，一帧都没补。
     v4：加了 __zcrcKbWill 协议，但 WebKit 会**先发 resize、后改布局**：
         resize 那一拍读到的位移还是 0，于是把正在跑的 transform 清掉，
         下一拍布局才落，结果还是单帧跳变（实测 377 → 227 单帧 150px）。

   v5 做法（结论：必须「事件后再多测两拍」）：
     1) 协议：__zcrcKbWill(h, ms) → 立刻给 composerStack 打 transform -h、时长 ms
        （合成层执行，不重排），与键盘同刻同长一起上滑；
     2) resize 后不只测一次：rAF / 60ms / 160ms 各测一拍，**看到布局真的动了**
        （位移 ≥6px）才交接 —— 先同步把视觉钉在旧位置（paint 之前），下一帧带
        剩余时长滑到 0；
     3) 收键盘：App 先还原高度、再 __zcrcKbWill(0)，同样靠这三拍抓住布局回位；
     4) 无协议（老 App / Safari）：退回「一次性跳变才补 240ms」，逐帧小步不插手；
     5) 保险：若 App 调了协议却没有改高度（异常路径），hint+500ms 后自行归位，
        绝不让输入区卡在半空。

   范围：仅触摸设备 + 未开「减弱动态效果」；桌面端零影响。
*/

export function installKbGlide() {
  var W = typeof window !== 'undefined' ? window : null;
  if (!W) return;
  var D = W.document;
  if (!D || W.__zcrcKbGlide) return;

  var touch = false;
  try { touch = ('ontouchstart' in W) || (navigator.maxTouchPoints || 0) > 1; } catch (e) {}
  if (!touch) { W.__zcrcKbGlide = 'skip-desktop'; return; }

  var reduce = false;
  try { reduce = !!(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
  if (reduce) { W.__zcrcKbGlide = 'skip-reduced-motion'; return; }

  var el = null;
  var layoutTop = null;     /* 去掉自身 transform 后的布局位置 */
  var lastAt = 0;
  var hintMs = 0;           /* App 给的系统动画时长 */
  var pins = 0;             /* 交接/补抓次数（诊断） */
  var moves = 0;            /* 协议上滑次数（诊断） */
  var protoUntil = 0;       /* 协议窗口结束时刻 */
  var closeMs = 0;          /* 收键盘待滑时长 */
  var closeUntil = 0;

  function now() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }

  /* 底部输入区整块：DSH 用 CSS Modules，类名带哈希前缀，只能按子串匹配 */
  function pick() {
    if (el && el.isConnected) return el;
    el = null;
    var found = null;
    try { found = D.querySelector('[class*="composerStack"]'); } catch (e) {}
    if (!found) {
      try {
        var list = D.querySelectorAll('textarea,[contenteditable="true"]');
        var vh = W.innerHeight || 0;
        for (var i = 0; i < list.length; i++) {
          var r = list[i].getBoundingClientRect();
          if (r.width < 160 || r.height < 16 || r.top < vh * 0.45) continue;
          found = list[i];
          break;
        }
      } catch (e) {}
    }
    el = found || null;
    return el;
  }

  /* 读当前 transform 的 ty（矩阵第 6/14 位） */
  function tyOf(node) {
    try {
      var t = W.getComputedStyle(node).transform;
      if (!t || t === 'none') return 0;
      var m = /matrix(3d)?\(([^)]+)\)/.exec(t);
      if (!m) return 0;
      var p = m[2].split(',');
      return parseFloat(m[1] ? p[13] : p[5]) || 0;
    } catch (e) { return 0; }
  }

  function setTy(node, v, ms) {
    try {
      node.style.transition = ms > 0 ? ('transform ' + ms + 'ms cubic-bezier(.25,.1,.25,1)') : 'none';
      node.style.transform = Math.abs(v) < 0.5 ? '' : ('translate3d(0,' + (Math.round(v * 10) / 10) + 'px,0)');
    } catch (e) {}
  }

  function raf(fn) {
    try { if (W.requestAnimationFrame) { W.requestAnimationFrame(fn); return; } } catch (e) {}
    setTimeout(fn, 16);
  }

  /* 核心：量一次，只有「布局真的动了」才交接 */
  function check() {
    var node = pick();
    if (!node) return;
    var t = now();
    var cur = tyOf(node);
    var layout = node.getBoundingClientRect().top - cur;
    if (layoutTop === null) { layoutTop = layout; lastAt = t; return; }
    var d = layout - layoutTop;              /* 负=上移 */
    var visual = layoutTop + cur;            /* 此刻屏幕上的位置 */
    if (Math.abs(d) < 6) { lastAt = t; return; }   /* 这一拍布局还没动 */
    layoutTop = layout;
    lastAt = t;
    var ms;
    if (protoUntil && t < protoUntil + 260) ms = Math.max(80, Math.min(hintMs || 250, protoUntil - t));
    else if (closeMs && t < closeUntil) ms = Math.max(80, Math.min(closeMs, closeUntil - t));
    else ms = hintMs || 240;
    closeMs = 0;
    setTy(node, visual - layout, 0);         /* 先钉住旧视觉位置（paint 之前生效） */
    try { void node.offsetHeight; } catch (e) {}   /* 强制提交起始值 */
    setTy(node, 0, ms);                      /* 立刻起过渡：不等 rAF，慢机也不会卡在半路 */
    pins++;
  }

  function burst(extra) {
    raf(check);
    setTimeout(check, 60);
    setTimeout(check, 160);
    if (extra) setTimeout(check, 320);
  }

  /* 键盘落定后的动态贴底校正（2026-11-10 老总令：不写死、检测再适配）：
     实测 composerStack 视觉底到视口底的 gap，量多少清多少（只清 padding/margin，
     不写死任何高度值）；不同机型键盘高度不同、官方样式再怎么改都自适应。
     最多校两轮，全部基于当次测量。 */
  function adjustKbGap() {
    try {
      if (!D.documentElement.classList.contains('zcrc-kb-open')) return;
      var stack = D.querySelector('[class*="composerStack"]') || pick();
      if (!stack) return;
      var round = 0;
      function pass() {
        var s = D.querySelector('[class*="composerStack"]') || pick();
        if (!s) return;
        var r = s.getBoundingClientRect();
        var gap = (W.innerHeight || 0) - r.bottom;
        if (gap > 4) {
          var cs = W.getComputedStyle(s);
          if (parseFloat(cs.paddingBottom) > 0) s.style.paddingBottom = '0px';
          else if (parseFloat(cs.marginBottom) > 0) s.style.marginBottom = '0px';
          else if (s.parentElement && s.parentElement !== D.body) {
            var pcs = W.getComputedStyle(s.parentElement);
            if (parseFloat(pcs.paddingBottom) > 0) s.parentElement.style.paddingBottom = '0px';
          }
        }
        if (++round < 3) setTimeout(pass, 120);
      }
      pass();
    } catch (e) {}
  }

  function onGeom() {
    /* 无协议路径（Safari/老 App）：按视口高度伸缩自行判键盘态 */
    try {
      var ih = W.innerHeight || 0;
      if (!onGeom._ih) onGeom._ih = ih;
      else {
        if (ih < onGeom._ih * 0.8) {
          D.documentElement.classList.add('zcrc-kb-open');
          setTimeout(adjustKbGap, 420);
        } else if (ih > onGeom._ih * 1.15) D.documentElement.classList.remove('zcrc-kb-open');
        onGeom._ih = ih;
      }
    } catch (e) {}
    burst(false);
  }

  /* App 152：keyboardWillChangeFrame 里、动画开始之前调这个 */
  W.__zcrcKbWill = function (h, ms) {
    var v = parseFloat(ms);
    var dur = (v > 80 && v < 600) ? v : 250;
    var px = Math.max(0, parseFloat(h) || 0);
    var node = pick();
    hintMs = dur;
    try {                                       /* 键盘态收纳（2026-11-10：底栏贴键盘顶，去掉空白） */
      if (px > 8) D.documentElement.classList.add('zcrc-kb-open');
      else D.documentElement.classList.remove('zcrc-kb-open');
    } catch (e0) {}
    if (node) {
      var cur = tyOf(node);
      if (layoutTop === null) layoutTop = node.getBoundingClientRect().top - cur;
      if (px > 8) {
        /* 弹键盘：布局还没动，先在合成层把整块上滑 px，与键盘同刻同长 */
        protoUntil = now() + dur + 260;
        moves++;
        setTy(node, -px, dur);
        setTimeout(adjustKbGap, dur + 420);   /* 落定后实测贴底缺口，动态校正 */
        setTimeout(function () {          /* 保险：高度没跟着改就自己归位 */
          if (protoUntil && now() > protoUntil + 240 && el && Math.abs(tyOf(el)) > 6) {
            setTy(el, 0, 200);
            protoUntil = 0;
          }
        }, dur + 520);
      } else {
        /* 收键盘：App 已还原高度（可能本拍还没重排），三拍内抓住并滑回 */
        closeMs = dur;
        closeUntil = now() + dur + 300;
      }
    }
    burst(true);
  };

  /* App 在协议窗口内调用，表示「这段 resize 别自己起动画」——v5 由 check 统一接管 */
  W.__zcrcKbHold = function () {};

  function reset() {
    layoutTop = null;
    closeMs = 0;
    protoUntil = 0;
    if (el && el.isConnected) setTy(el, 0, 0);
  }

  W.__zcrcKbGlide = 'dsh-v5';
  W.__zcrcKbPins = function () { return pins; };
  W.__zcrcKbMoves = function () { return moves; };

  try {
    W.addEventListener('resize', onGeom);
    if (W.visualViewport) W.visualViewport.addEventListener('resize', onGeom);
    W.addEventListener('orientationchange', function () { setTimeout(reset, 400); });
    D.addEventListener('focusin', function () { if (!hintMs) hintMs = 250; }, true);
  } catch (e) {}
}

/* 补丁自更新：页面 HTML 会随 client.js 的 rev 变化，但 WebView 里常驻的旧页面收不到。
   每 2 分钟比一次「页面里的 rev」与「服务器上的 rev」，只有满足
   「可见 + 无输入焦点 + 20 秒无操作 + 本 rev 没重载过」才自动刷新一次，绝不打断输入。 */
export function installRevWatch() {
  var W = typeof window !== 'undefined' ? window : null;
  if (!W) return;
  var D = W.document;
  if (!D || W.__zcrcRevWatch) return;
  W.__zcrcRevWatch = 'v1';

  var ownRev = '';
  try {
    var html = D.documentElement ? D.documentElement.innerHTML : '';
    var m = /dsh-anywhere-hub\/client\.js&(?:amp;)?rev=([0-9a-f]+)/.exec(html);
    if (m) ownRev = m[1];
  } catch (e) {}
  if (!ownRev) return;

  var KEY = 'dsh-anywhere-hub-rev-reloaded';
  var lastAct = 0;
  function mark() {
    try { lastAct = performance.now(); } catch (e) { lastAct = Date.now(); }
  }
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (n) {
    D.addEventListener(n, mark, { passive: true, capture: true });
  });

  function tick() {
    try {
      if (D.visibilityState !== 'visible') return;
      var t = performance.now();
      if (lastAct && t - lastAct < 20000) return;
      var a = D.activeElement;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName)) return;
      if (a && a.isContentEditable) return;
      fetch('/', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (h) {
        var m = /dsh-anywhere-hub\/client\.js&(?:amp;)?rev=([0-9a-f]+)/.exec(h);
        if (!m || m[1] === ownRev) return;
        try {
          if (sessionStorage.getItem(KEY) === m[1]) return;
          sessionStorage.setItem(KEY, m[1]);
        } catch (e) {}
        W.location.reload();
      }).catch(function () {});
    } catch (e) {}
  }
  setTimeout(tick, 15000);
  setInterval(tick, 120000);
}

/* ─────────────────────────────────────────────────────────────────────
 * composer 交互修补（installComposerFix，2026-11-10 老总令三连）
 *   ① 点「发送/停止」后不再自动弹键盘：
 *      App 层状态机有「点击点 80px 内有输入框也算要输入」的放行分支，发送按钮
 *      紧挨输入框 → 点击它把放行窗口打开 → 发送后页面的 focusDraftEditor 在
 *      1.5s 窗口内被放行 → 键盘弹。此处捕获发送按钮点击 → 主动 blur + 900ms
 *      内拦截一切程序化聚焦（插件层 wrap 在 App 层之外，此处 return 即彻底拦死）；
 *      用户真点输入框立即解除抑制，正常打字不受影响。
 *   ② 键盘态底栏贴键盘顶：html.zcrc-kb-open 时收掉 composerStack 常驻的
 *      32px 安全区 padding、「38轮/用量」pill 状态条与 root padding，卡片下移贴键盘；
 *      收键盘自动还原。布局差由 kbglide 三拍滑块滑平，不生跳。
 *   ③ 草稿限高：编辑器滚动容器封顶 34vh 内部滚动，草稿再多卡片不再无限撑高
 *      （撑高到顶会把输入框顶出可点区，点上去像卡死）。
 * ───────────────────────────────────────────────────────────────────── */
export function installComposerFix() {
  var W = typeof window !== 'undefined' ? window : null;
  if (!W) return;
  var D = W.document;
  if (!D || W.__zcrcComposerFix) return;
  W.__zcrcComposerFix = 'v2';

  var suppressUntil = 0;
  function now() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }
  function isTextInput(el) {
    try {
      if (!el) return false;
      if (el.isContentEditable || (el.getAttribute && el.getAttribute('contenteditable') === 'true')) return true;
      var t = el.tagName;
      if (t === 'TEXTAREA') return true;
      if (t === 'INPUT') return !/^(button|submit|checkbox|radio|range|file)$/i.test(el.type || '');
    } catch (e) {}
    return false;
  }

  try {
    var css = [
      '/* dsh-anywhere-hub composer fix */',
      '[class*="CHtLlW_scroll"]{max-height:34vh;overflow-y:auto;-webkit-overflow-scrolling:touch;}',
      'html.zcrc-kb-open [class*="composerStack"]{padding-bottom:0!important;}',
      'html.zcrc-kb-open [class*="CHtLlW_root"]{padding-bottom:0!important;}',
      'html.zcrc-kb-open [class*="riMk1q_pill"]{display:none!important;}',
      'html.zcrc-kb-open [class*="riMk1q_root"]{display:none!important;}'
    ].join('');
    var st = D.createElement('style');
    st.id = 'zcrcComposerFix';
    st.textContent = css;
    (D.head || D.documentElement).appendChild(st);
  } catch (e) {}

  /* 信标：会话框键盘链路诊断 → 3090 网关日志（跨域 no-cors，失败静默） */
  var beaconLast = 0;
  function beacon(msg) {
    try {
      var ts = Date.now();
      if (ts - beaconLast < 1200) return;
      beaconLast = ts;
      var host = location.hostname;
      if (!host || location.protocol === 'file:') return;
      var url = 'http://' + host + ':3090/zcode-rc-api/__beacon?m=' + encodeURIComponent('DSHKB ' + msg + ' v=' + (W.__zcrcKbGlide || '?'));
      if (navigator.sendBeacon) { navigator.sendBeacon(url); return; }
      W.fetch(url, { mode: 'no-cors', keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  /* 定位会话框输入框：哈希类名优先，退化为「底部宽输入框」 */
  function composerEditor() {
    var eds = D.querySelectorAll('textarea,[contenteditable="true"]');
    var i, ed;
    for (i = 0; i < eds.length; i++) {
      ed = eds[i];
      if (ed.closest && ed.closest('[class*="CHtLlW_root"],[class*="composerStack"]')) return ed;
    }
    for (i = 0; i < eds.length; i++) {
      ed = eds[i];
      var rr = ed.getBoundingClientRect();
      if (rr.width > innerWidth * 0.6 && rr.top > innerHeight * 0.5) return ed;
    }
    return null;
  }

  /* ① 发送/停止按钮点击（2026-11-10 重做）：
   *    - 输入框本来没聚焦（键盘关着）→ 拦掉随后的页面自动重聚焦（老诉求：点发送键盘又弹）；
   *    - 输入框正在聚焦（排队连发场景）→ 保持聚焦：不 blur、不抑制，键盘不塌，
   *      待发送第二条直接打字。旧版无条件 blur+抑制，是「排队后再点会话框弹不出键盘」
   *      链路里我们自己埋的一环。 */
  try {
    D.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('[class*="CHtLlW_primary"]')) {
        var ed = composerEditor();
        var hadFocus = !!(ed && (ed === D.activeElement || (ed.contains && ed.contains(D.activeElement))));
        if (!hadFocus) suppressUntil = now() + 900;
        beacon('send hf=' + (hadFocus ? 1 : 0));
      }
    }, true);
  } catch (e) {}

  /* ②+④ 用户真点会话框输入框：解除抑制 + 手势内同步聚焦。
   * iOS WKWebView 只认「用户手势内同步调用的 focus」弹键盘；排队等状态下 React 的
   * onClick focus 可能不触发或被任何一层吞掉 → 在 touchstart 捕获段直接补 focus。
   * App 层放行监听（document_start 注册）先于本监听执行：点输入框即放行 1.5s，链路自洽。 */
  try {
    var touchFocus = function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var ed = isTextInput(t) ? t : null;
      if (!ed) { var c = t.closest('[contenteditable="true"],textarea'); if (c && isTextInput(c)) ed = c; }
      if (!ed) return;
      var inComposer = ed.closest('[class*="CHtLlW_root"],[class*="composerStack"]');
      if (!inComposer) {
        var r = ed.getBoundingClientRect();
        if (!(r.width > innerWidth * 0.6 && r.top > innerHeight * 0.5)) return;   // 只管会话框，不碰代码块/搜索框
      }
      suppressUntil = 0;
      if (D.activeElement === ed || (ed.contains && ed.contains(D.activeElement))) return;
      try { ed.focus({ preventScroll: true }); } catch (e2) { try { ed.focus(); } catch (e3) {} }
      beacon('assist y=' + Math.round(ed.getBoundingClientRect().top));
    };
    D.addEventListener('touchstart', touchFocus, true);
  } catch (e) {}
  try {
    var release = function (e) {
      var t = e.target;
      if (t && isTextInput(t)) suppressUntil = 0;
    };
    D.addEventListener('mousedown', release, true);
  } catch (e) {}

  /* ③ wrap focus：抑制窗口内的程序化聚焦直接拦死 */
  try {
    var of = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (o) {
      if (now() < suppressUntil && isTextInput(this)) return;
      return of.apply(this, arguments);
    };
  } catch (e) {}
}
