/* zcode-rc 手机端适配补丁 v3（由 3090 网关注入到 /remote/v4 页面 <head>）
 * 2026-11-07 真机第三版：v2 仍没解决底部输入框压 Home 条，真因补齐如下——
 *   ① 该 WKWebView 是「整屏全出血」：innerHeight === screen.height，容器一点安全区都不让；
 *   ② 页面 viewport 虽已被网关补成 viewport-fit=cover，但 WebKit 在「webview 未声明
 *      safeAreaInsets」时 env(safe-area-inset-*) 仍然返回 0 —— 不能只靠 env()；
 *   ③ 容器也不下发 window.__dshSafeArea / --dsh-sb-native（老容器）。
 *   三条全断 → v2 的 insets() 恒等于 0/0，输入框原地不动。这就是「底部会话框超出屏幕」。
 * 本版：
 *   ① 四级取值：env() → __dshSafeArea → --dsh-sb-native → **机型几何表**（按 CSS 像素
 *      宽高查 iPhone 刘海/灵动岛安全区，兜底 47/34），iOS 全出血时必有确定值；
 *   ② 容器自己让出安全区（innerHeight 明显小于 screen.height）时一律不补，绝不双倍留白；
 *   ③ 修 v2 的真 bug：lastT/lastB 缓存会让 React 换掉外壳后永不重刷 → 现在按「元素+数值」双判定；
 *   ④ 目标仍是 #root 下第一个占满视口的容器（外层 .relative.h-dvh），不是会话面板；
 *   ⑤ 横向兜底：真出现横向溢出时给 html/body 加 overflow-x:hidden，杜绝左右出界；
 *   ⑥ 左缘右滑 = 返回；⑦ 已登录隐藏「⇥ 登录回调」悬浮桥；⑧ 每页回传 diag 信标落网关日志。
 * 纯 ES5，无正则字面量，不改页面任何业务逻辑。
 */
!function () {
  try {
    var doc = document;
    var D = doc.documentElement;
    var shellEl = null;
    var lastT = -1;
    var lastB = -1;
    var BEACON = '/zcode-rc-api/__beacon';

    function num(v) {
      var n = parseFloat(v);
      return isFinite(n) ? n : 0;
    }

    function isIOS() {
      try {
        var ua = navigator.userAgent || '';
        if (ua.indexOf('iPhone') >= 0 || ua.indexOf('iPad') >= 0 || ua.indexOf('iPod') >= 0) return true;
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
      } catch (e) {}
      return false;
    }

    /* 真属性探针：CSS 自定义属性里的 env() 在 WebKit 不会提前求值，
       必须落到 padding-top/bottom 这种真实属性上再读计算值。 */
    function envPx(side) {
      try {
        var d = doc.createElement('div');
        d.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:0;height:0;visibility:hidden;pointer-events:none';
        d.style.setProperty('padding-' + side, 'env(safe-area-inset-' + side + ',0px)');
        (doc.body || D).appendChild(d);
        var v = num(getComputedStyle(d).getPropertyValue('padding-' + side));
        if (d.parentNode) d.parentNode.removeChild(d);
        return v;
      } catch (e) {
        return 0;
      }
    }

    function nativeTop() {
      var v = 0;
      try {
        v = num(getComputedStyle(D).getPropertyValue('--dsh-sb-native'));
      } catch (e) {}
      if (!v) {
        try {
          v = num(D.style.getPropertyValue('--dsh-sb-native'));
        } catch (e) {}
      }
      return v;
    }

    // 容器自己让出安全区（视口比整屏矮）→ 页面不能再补
    function containerInset() {
      try {
        var sh = window.screen && window.screen.height ? window.screen.height : 0;
        if (sh && window.innerHeight < sh - 8) return true;
      } catch (e) {}
      return false;
    }

    /* 机型几何表（CSS 像素，竖屏）：[宽, 高, 顶部, 底部]。
       全出血 WKWebView 上 env() 不可信时，这是唯一确定值来源。
       注意 414×896 有两种机型（CSS 尺寸相同、物理分辨率不同）：
         dpr=3 → XS Max / 11 Pro Max，状态栏 44；dpr=2 → XR / 11，状态栏 48。
       真机信标实测该容器报 dpr=3，故按 dpr 分辨。 */
    var IOS_TABLE = [
      [320, 568, 20, 0],   // SE 1 / 5s
      [375, 667, 20, 0],   // 6/7/8/SE2/SE3
      [414, 736, 20, 0],   // 6+/7+/8+
      [375, 812, 48, 34],  // X / XS / 11 Pro (44) / 12·13 mini (50)
      [390, 844, 47, 34],  // 12 / 13 / 14
      [428, 926, 47, 34],  // 12·13 Pro Max / 14 Plus
      [393, 852, 59, 34],  // 14 Pro / 15 / 15 Pro
      [430, 932, 59, 34],  // 14 Pro Max / 15 Plus / 16 Plus
      [402, 874, 62, 34],  // 16 Pro
      [440, 956, 62, 34]   // 16 Pro Max
    ];

    function tableInsets() {
      var w = 0;
      var h = 0;
      var dpr = 0;
      try {
        w = Math.round((window.screen && window.screen.width) || window.innerWidth || 0);
        h = Math.round((window.screen && window.screen.height) || window.innerHeight || 0);
        dpr = window.devicePixelRatio || 0;
      } catch (e) {}
      if (!w || !h) return null;
      var landscape = false;
      try { landscape = (window.innerWidth || 0) > (window.innerHeight || 0); } catch (e) {}
      var shortSide = Math.min(w, h);
      var longSide = Math.max(w, h);
      // 414×896：dpr 3 = XS Max/11 Pro Max(44)，dpr 2 = XR/11(48)
      if (Math.abs(shortSide - 414) <= 1 && Math.abs(longSide - 896) <= 1) {
        return landscape ? { t: 0, b: 21 } : { t: dpr >= 2.5 ? 44 : 48, b: 34 };
      }
      for (var i = 0; i < IOS_TABLE.length; i++) {
        var r = IOS_TABLE[i];
        if (Math.abs(r[0] - shortSide) <= 1 && Math.abs(r[1] - longSide) <= 1) {
          // 横屏：顶部状态栏让位（顶部为 0），底部 Home 条仍在（21px）
          return landscape ? { t: 0, b: r[3] ? 21 : 0 } : { t: r[2], b: r[3] };
        }
      }
      // 未收录机型：按长宽比判断是否刘海机（≥1.75 才有 Home 条）
      var ratio = longSide / shortSide;
      if (ratio >= 1.9) return landscape ? { t: 0, b: 21 } : { t: 47, b: 34 };
      if (ratio >= 1.75) return landscape ? { t: 0, b: 21 } : { t: 44, b: 34 };
      return { t: 20, b: 0 };
    }

    function insets() {
      var t = envPx('top');
      var b = envPx('bottom');
      if (t > 0 || b > 0) return { t: Math.round(t), b: Math.round(b), src: 'env' };
      if (containerInset()) return { t: 0, b: 0, src: 'container' };
      var sa = null;
      try {
        if (window.__dshSafeAreaReady && window.__dshSafeArea) sa = window.__dshSafeArea;
      } catch (e) {}
      if (sa) {
        var st = Math.round(num(sa.top));
        var sb = Math.round(num(sa.bottom));
        if (st > 0 || sb > 0) return { t: st, b: sb, src: 'native-sa' };
      }
      var nt = nativeTop();
      if (nt > 0) return { t: Math.round(nt), b: 34, src: 'native-var' };
      if (isIOS()) {
        var tb = tableInsets();
        if (tb) return { t: tb.t, b: tb.b, src: 'table' };
      }
      return { t: 0, b: 0, src: 'none' };
    }

    /* 最外层整屏容器：#root 下第一个宽高都接近视口的元素。
       优先与注入 CSS 兜底命中的是同一个节点（#root>div 且 class 含 h-dvh），
       否则 CSS 补外层、JS 补内层会变成双倍留白。
       h-dvh 是 100dvh，padding 走 border-box，不影响高度 → 命中结果稳定。 */
    function findShell() {
      try {
        if (shellEl && D.contains(shellEl)) return shellEl;
      } catch (e) {}
      shellEl = null;
      try {
        var vw = window.innerWidth || 1;
        var vh = window.innerHeight || 1;
        function covers(el, wRatio, hRatio) {
          var r = el.getBoundingClientRect();
          return r.width >= vw * wRatio && r.height >= vh * hRatio;
        }
        var cssNet = doc.querySelector('#root > div[class*="h-dvh"]');
        if (cssNet && covers(cssNet, 0.9, 0.85)) shellEl = cssNet;
        if (!shellEl) {
          var list = doc.querySelectorAll('#root > div, #root div');
          for (var i = 0; i < list.length; i++) {
            if (covers(list[i], 0.9, 0.85)) {
              shellEl = list[i];
              break;
            }
          }
        }
        if (!shellEl) {
          var root = doc.getElementById('root');
          if (root && root.firstElementChild) shellEl = root.firstElementChild;
        }
      } catch (e) {}
      return shellEl;
    }

    function applyInsets() {
      var v = insets();
      try {
        D.style.setProperty('--zcrc-sb-top', v.t + 'px');
        D.style.setProperty('--zcrc-sb-bottom', v.b + 'px');
      } catch (e) {}
      var s = findShell();
      if (!s) return;
      try {
        // v3：外壳被 React 换掉时也要重刷（v2 只比数值，换元素后永不重打）
        if (s.__zcrcShell !== 1) {
          s.__zcrcShell = 1;
          s.style.boxSizing = 'border-box';
          lastT = -1;
          lastB = -1;
        }
        if (v.t !== lastT) {
          s.style.paddingTop = v.t + 'px';
          lastT = v.t;
        }
        if (v.b !== lastB) {
          s.style.paddingBottom = v.b + 'px';
          lastB = v.b;
        }
        /* v3 关键：内层还有一层 `h-dvh`（100dvh = 整屏 896px），它不会跟着外壳的
           padding 缩，反而会顶出去 → 输入框继续压在 Home 条上（实测 footer 940 > 896）。
           把内层 h-dvh 一律改成 100%（= 外壳 padding 后的内容高），整条 flex 链才会真正缩短。 */
        if (v.t > 0 || v.b > 0) {
          var inner = s.querySelectorAll('[class*="h-dvh"]');
          for (var i = 0; i < inner.length; i++) {
            if (inner[i] === s) continue;
            if (inner[i].__zcrcH !== 1) {
              inner[i].__zcrcH = 1;
              inner[i].style.height = '100%';
              inner[i].style.minHeight = '0px';
            }
          }
        }
      } catch (e) {}
    }

    /* ⑤ 横向兜底：真溢出才锁，避免误伤页面内部横向滚动 */
    function fixOverflowX() {
      try {
        var over = D.scrollWidth - (window.innerWidth || 0);
        if (over > 1) {
          if (D.style.overflowX !== 'hidden') D.style.overflowX = 'hidden';
          var bd = doc.body;
          if (bd && bd.style.overflowX !== 'hidden') bd.style.overflowX = 'hidden';
        }
      } catch (e) {}
    }

    function hasToken() {
      try {
        return !!(localStorage.getItem('oauth:zai:access_token')
          || localStorage.getItem('zcodejwttoken')
          || localStorage.getItem('oauth:bigmodel:access_token'));
      } catch (e) {
        return false;
      }
    }

    /* ⑦ 「⇥ 登录回调」：免登录注入成功后纯属干扰（还压住发送键），已登录就隐藏。 */
    function fixBridge() {
      try {
        var logged = hasToken() || !!window.__zcrcAutologin;
        var bs = doc.querySelectorAll('button');
        for (var i = 0; i < bs.length; i++) {
          var txt = bs[i].textContent || '';
          if (txt.indexOf('登录回调') < 0) continue;
          if (logged) {
            if (bs[i].style.display !== 'none') bs[i].style.display = 'none';
          } else {
            bs[i].style.display = '';
            bs[i].style.bottom = 'calc(12px + var(--zcrc-sb-bottom,0px))';
          }
        }
      } catch (e) {}
    }

    /* ⑥ 左缘右滑 = 返回：原生侧滑被容器关了，页面也没有可点的「返回任务首页」按钮，
       统一走 history.back()（SPA 路由是 pushState，回退即回上一屏）。 */
    var startX = 0;
    var startY = 0;
    var tracking = false;
    function onStart(e) {
      try {
        if (!e.touches || e.touches.length !== 1) return;
        var t0 = e.touches[0];
        if (t0.clientX > 28) return;
        startX = t0.clientX;
        startY = t0.clientY;
        tracking = true;
      } catch (err) {}
    }
    function onMove(e) {
      if (!tracking) return;
      try {
        var t0 = e.touches[0];
        var dx = t0.clientX - startX;
        var dy = t0.clientY - startY;
        if (dx > 70 && dy > -70 && dy < 70) {
          tracking = false;
          if (window.history && history.length > 1) history.back();
        }
      } catch (err) {}
    }
    function onEnd() {
      tracking = false;
    }
    try {
      doc.addEventListener('touchstart', onStart, { passive: true });
      doc.addEventListener('touchmove', onMove, { passive: true });
      doc.addEventListener('touchend', onEnd, { passive: true });
      doc.addEventListener('touchcancel', onEnd, { passive: true });
    } catch (e) {}

    function tick() {
      applyInsets();
      fixOverflowX();
      fixBridge();
    }

    /* ⑨ v15：启动看门狗（2026-11-07 真机实锤：iOS 16.3 停在 Z 形启动壳）。
       v14 只看 #root 是否「空」，而启动壳里自带 "Loading..." 文本 →
       永远判定「正常」，面板一次都不出，等于瞎的。本版改成看启动壳本身：
         · 2s  探测网关可达性（决定「网络不通」还是「脚本炸了」）
         · 9s  仍卡启动壳且网关可达 → 带 cache-bust 自动重载一次（WKWebView 吃旧 HTML 缓存的典型症状）
         · 20s 仍卡 → 全屏诊断面板（错误原文 + 缺失 API + 可达性），并回传 STUCK
       重载 10 分钟内最多 2 次，绝不进死循环。 */
    var lastErr = '';
    try {
      window.addEventListener('error', function (e) {
        try {
          var t = e && e.target;
          if (t && t !== window && (t.src || t.href)) {
            lastErr = '资源加载失败: ' + String(t.src || t.href).slice(0, 140);
            try { if (t.tagName === 'SCRIPT') t.setAttribute('data-zcrc-failed', '1'); } catch (x) {}
          } else {
            lastErr = String((e && e.message) || 'error')
              + (e && e.filename ? ' @' + String(e.filename).split('/').pop() + ':' + e.lineno : '');
          }
        } catch (x) {}
      }, true);
      window.addEventListener('unhandledrejection', function (e) {
        try {
          lastErr = 'Promise: ' + String((e && e.reason && (e.reason.message || e.reason)) || 'rejected').slice(0, 180);
        } catch (x) {}
      });
    } catch (e) {}

    function looksBlank() {
      try {
        var root = doc.getElementById('root');
        if (!root) return true;
        if (root.childElementCount === 0) return true;
        var txt = String(root.textContent || '').replace(/\s+/g, '');
        if (txt.length > 0) return false;
        return root.getBoundingClientRect().height < 40;
      } catch (e) {
        return false;
      }
    }

    /* 启动壳还在不在（官方 index.html 里 class="zcode-boot-loading"） */
    function bootShell() {
      try {
        return doc.querySelector('.zcode-boot-loading') || null;
      } catch (e) {
        return null;
      }
    }

    /* 网关可达性：2s 时打一条 ping 信标，成功即证明「网络通、问题在页面」 */
    var netOK = null;
    function ping() {
      try {
        fetch(BEACON + '?m=ping&t=' + Date.now(), { mode: 'no-cors', cache: 'no-store' })
          .then(function () { netOK = true; })
          .catch(function () { netOK = false; });
      } catch (e) { netOK = false; }
    }

    function bustUrl() {
      try {
        var u = location.href;
        var i = u.indexOf('#');
        var hash = i >= 0 ? u.slice(i) : '';
        var base = i >= 0 ? u.slice(0, i) : u;
        base = base.replace(/([?&])__zcrcr=[^&]*/g, '$1').replace(/[?&]$/, '');
        return base + (base.indexOf('?') >= 0 ? '&' : '?') + '__zcrcr=' + Date.now() + hash;
      } catch (e) {
        return location.href;
      }
    }

    /* 自动重载闸：10 分钟内最多 2 次，sessionStorage 不可用时退回内存标记 */
    function mayReload() {
      try {
        if (window.__zcrcBootReloads && window.__zcrcBootReloads >= 2) return false;
        var now = Date.now();
        var o = null;
        try { o = JSON.parse(sessionStorage.getItem('zcrc_boot_reload') || 'null'); } catch (e) {}
        if (o && o.t && now - o.t < 600000) {
          if (o.n >= 2) return false;
          o.n++;
        } else {
          o = { n: 1, t: now };
        }
        try { sessionStorage.setItem('zcrc_boot_reload', JSON.stringify(o)); } catch (e) {}
        window.__zcrcBootReloads = o.n;
        return true;
      } catch (e) {
        return true;
      }
    }

    function showPanel(msg) {
      try {
        if (doc.getElementById('zcrcWhite')) return;
        var box = doc.createElement('div');
        box.id = 'zcrcWhite';
        box.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483647;background:#111;color:#eee;'
          + 'font:12px/1.55 ui-monospace,Menlo,monospace;padding:16px;padding-top:calc(16px + var(--zcrc-sb-top,0px));'
          + 'overflow:auto;-webkit-overflow-scrolling:touch';
        var h = doc.createElement('div');
        h.style.cssText = 'font:600 14px -apple-system,system-ui,sans-serif;margin-bottom:8px;color:#ffd60a';
        h.textContent = '页面没起来（诊断已回传电脑）';
        var b = doc.createElement('div');
        b.style.cssText = 'white-space:pre-wrap;word-break:break-all;opacity:.85';
        b.textContent = msg;
        var r = doc.createElement('button');
        r.textContent = '重新加载';
        r.style.cssText = 'margin-top:14px;padding:9px 16px;border:0;border-radius:8px;background:#fff;color:#000;'
          + 'font:600 13px -apple-system,system-ui,sans-serif';
        r.onclick = function () { location.reload(); };
        box.appendChild(h);
        box.appendChild(b);
        box.appendChild(r);
        (doc.body || D).appendChild(box);
      } catch (e) {}
    }

    function reportBlank() {
      try {
        if (!looksBlank()) return;
        var m = 'ua=' + String(navigator.userAgent || '').slice(0, 92)
          + ' err=' + (lastErr || 'none')
          + ' toSorted=' + (typeof [].toSorted)
          + ' withResolvers=' + (typeof Promise.withResolvers)
          + ' fromAsync=' + (typeof Array.fromAsync)
          + ' miss=' + (window.__zcrcMiss || '?')
          + ' readyState=' + doc.readyState;
        fetch(BEACON + '?m=' + encodeURIComponent('WHITE ' + m), { mode: 'no-cors' }).catch(function () {});
        showPanel(m);
      } catch (e) {}
    }

    function stuckDiag() {
      var scripts = 0, failed = 0;
      try {
        var ss = doc.getElementsByTagName('script');
        scripts = ss.length;
        for (var i = 0; i < ss.length; i++) {
          if (ss[i].getAttribute('data-zcrc-failed') === '1') failed++;
        }
      } catch (e) {}
      return 'ua=' + String(navigator.userAgent || '').slice(0, 100)
        + ' net=' + (netOK === true ? 'ok' : netOK === false ? 'FAIL' : '?')
        + ' err=' + (lastErr || 'none')
        + ' miss=' + (window.__zcrcMiss || '?')
        + ' toSorted=' + (typeof [].toSorted)
        + ' fromAsync=' + (typeof Array.fromAsync)
        + ' subtle=' + (window.crypto && crypto.subtle ? 'y' : 'n')
        + ' ready=' + doc.readyState
        + ' scripts=' + scripts + '/' + failed + 'fail'
        + ' reloads=' + (window.__zcrcBootReloads || 0);
    }

    function showStuck(m, kind) {
      try {
        if (doc.getElementById('zcrcStuck')) return;
        var box = doc.createElement('div');
        box.id = 'zcrcStuck';
        box.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483647;background:#0b0b0c;color:#eee;'
          + 'font:12px/1.55 ui-monospace,Menlo,monospace;padding:18px;'
          + 'padding-top:calc(18px + var(--zcrc-sb-top,0px));padding-bottom:calc(18px + var(--zcrc-sb-bottom,0px));'
          + 'overflow:auto;-webkit-overflow-scrolling:touch';
        var h = doc.createElement('div');
        h.style.cssText = 'font:600 15px -apple-system,system-ui,sans-serif;margin-bottom:10px;color:#ffd60a';
        h.textContent = kind === 'net' ? '连不上网关（诊断已回传电脑）' : '页面卡在启动（诊断已回传电脑）';
        var tip = doc.createElement('div');
        tip.style.cssText = 'font:13px/1.6 -apple-system,system-ui,sans-serif;margin-bottom:12px;color:#9ee6a1';
        tip.textContent = kind === 'net'
          ? '页面框架能打开，但请求到不了电脑上的网关。请确认手机和电脑在同一个 Wi-Fi，或换 100.113.97.47:3090 再试。'
          : '脚本没跑完（多半是这台系统缺某个新语法/新接口）。下面这段原文请截图发我，一行就够定位。';
        var b = doc.createElement('div');
        b.style.cssText = 'white-space:pre-wrap;word-break:break-all;opacity:.85;background:#17171a;border-radius:8px;padding:10px';
        b.textContent = m;
        var row = doc.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;margin-top:14px;flex-wrap:wrap';
        var r = doc.createElement('button');
        r.textContent = '重新加载';
        r.style.cssText = 'padding:9px 16px;border:0;border-radius:8px;background:#fff;color:#000;'
          + 'font:600 13px -apple-system,system-ui,sans-serif';
        r.onclick = function () { location.replace(bustUrl()); };
        var c = doc.createElement('button');
        c.textContent = '复制诊断';
        c.style.cssText = 'padding:9px 16px;border:0;border-radius:8px;background:#3a3a3c;color:#eee;'
          + 'font:600 13px -apple-system,system-ui,sans-serif';
        c.onclick = function () {
          try {
            var ta = doc.createElement('textarea');
            ta.value = m;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            doc.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, 99999);
            doc.execCommand('copy');
            doc.body.removeChild(ta);
            c.textContent = '已复制';
          } catch (e) {}
        };
        row.appendChild(r);
        row.appendChild(c);
        box.appendChild(h);
        box.appendChild(tip);
        box.appendChild(b);
        box.appendChild(row);
        (doc.body || D).appendChild(box);
      } catch (e) {}
    }

    function checkStuck(stage) {
      try {
        if (!bootShell()) return;      // 启动壳没了 = 页面起来了，永不介入
        if (doc.getElementById('zcrcStuck')) return;
        var m = stuckDiag();
        if (stage === 1) {
          // 语法级错误（缺新语法）重载也没用，直接摊牌，别再折腾用户
          if (/SyntaxError|is not a function|is not defined/.test(lastErr)) {
            fetch(BEACON + '?m=' + encodeURIComponent('STUCK-JS ' + m), { mode: 'no-cors' }).catch(function () {});
            showStuck(m, 'js');
            return;
          }
          // 网关可达、资源也加载完了却还卡启动 → 十有八九是 WKWebView 吃了旧 HTML/旧 bundle 缓存
          if (doc.readyState === 'complete' && netOK !== false && mayReload()) {
            fetch(BEACON + '?m=' + encodeURIComponent('STUCK-RELOAD ' + m), { mode: 'no-cors' }).catch(function () {});
            location.replace(bustUrl());
            return;
          }
          if (netOK === false) {
            fetch(BEACON + '?m=' + encodeURIComponent('STUCK-NET ' + m), { mode: 'no-cors' }).catch(function () {});
            showStuck(m, 'net');
            return;
          }
          return;                       // 已重载过，等下一档
        }
        fetch(BEACON + '?m=' + encodeURIComponent('STUCK ' + m), { mode: 'no-cors' }).catch(function () {});
        showStuck(m, netOK === false ? 'net' : 'js');
      } catch (e) {}
    }

    /* ⑩ v21（2026-11-07）：正向「已挂载」回执。
       以前只有「卡住才说话」（STUCK），页面正常时一条日志都没有 —— 只能靠「没有坏消息」
       反推成功，这在真机上不够硬。这里在启动壳消失的那一刻回一条 MOUNTED，
       带耗时 / 正文长度 / 节点数，成功也留痕，下次一看日志就知道到底起没起来。 */
    var mountT0 = Date.now();
    function watchMount() {
      var n = 0;
      var iv = setInterval(function () {
        try {
          n++;
          if (!bootShell()) {
            clearInterval(iv);
            var root = doc.getElementById('root');
            var txt = String((root && root.textContent) || '').replace(/\s+/g, '');
            var msg = 'MOUNTED ms=' + (Date.now() - mountT0)
              + ' txt=' + txt.length
              + ' els=' + (root ? root.querySelectorAll('*').length : -1)
              + ' h=' + (root ? Math.round(root.getBoundingClientRect().height) : -1);
            fetch(BEACON + '?m=' + encodeURIComponent(msg), { mode: 'no-cors' }).catch(function () {});
            return;
          }
          if (n > 200) clearInterval(iv);
        } catch (e) { clearInterval(iv); }
      }, 300);
    }

    function diag() {
      try {
        var s = findShell();
        var v = insets();
        var msg = 'ih=' + (window.innerHeight || 0)
          + ' sh=' + ((window.screen && window.screen.height) || 0)
          + ' sw=' + ((window.screen && window.screen.width) || 0)
          + ' vw=' + (window.innerWidth || 0)
          + ' dpr=' + (window.devicePixelRatio || 0)
          + ' envT=' + envPx('top') + ' envB=' + envPx('bottom')
          + ' sa=' + (window.__dshSafeArea ? (window.__dshSafeArea.top + '/' + window.__dshSafeArea.bottom) : 'none')
          + ' sbn=' + nativeTop()
          + ' src=' + v.src + ' pad=' + v.t + '/' + v.b
          + ' sw2=' + (D.scrollWidth || 0)
          + ' shell=' + (s ? String(s.className).slice(0, 40) : 'none')
          + ' shellPad=' + (s ? (s.style.paddingTop + '|' + s.style.paddingBottom) : 'none')
          + ' logged=' + (hasToken() ? 1 : 0)
          + ' miss=' + (window.__zcrcMiss || '?');
        fetch(BEACON + '?m=' + encodeURIComponent(msg), { mode: 'no-cors' }).catch(function () {});
      } catch (e) {}
    }

    try {
      window.addEventListener('resize', tick);
      window.addEventListener('orientationchange', tick);
      window.addEventListener('popstate', tick);
    } catch (e) {}

    function boot() {
      tick();
      watchMount();
      setTimeout(tick, 300);
      setTimeout(tick, 900);
      setTimeout(ping, 2000);
      setTimeout(diag, 2500);
      setTimeout(tick, 3000);
      setTimeout(reportBlank, 6000);
      setTimeout(diag, 7000);
      setTimeout(function () { checkStuck(1); }, 12000);
      setTimeout(reportBlank, 12000);
      setTimeout(function () { checkStuck(2); }, 24000);
      setTimeout(function () { checkStuck(3); }, 36000);
    }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
    setInterval(tick, 1500);
  } catch (e) {}
}();
