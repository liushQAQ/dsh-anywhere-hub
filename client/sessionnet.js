/* 会话切换网络调度（sessionnet）——治「快速连续切会话第二轮群卡 12~30s」。
 *
 * 2026-11-10 实测：快速连续切会话时，官方前端会对 mnemon 记忆快照、
 * turn-activities、agent-teams 归档列表这类重接口连发 GET；第二轮起服务端
 * 堆积到 12~30s（agent-teams archived=1 单次 29s），还会占满浏览器同源
 * 6 连接，把 dsh-purge/rewind 这类纯内存接口一起拖死。
 *
 * 这三层都只作用于**只读 GET**，不碰任何写请求：
 *   1) 同 URL 在途去重 —— 并发重复请求合并成一次网络往返；
 *   2) 这类接口并发上限 3 —— 其余 FIFO 排队，给正常业务留连接；
 *   3) 800ms 微缓存 —— 来回快速切换时直接命中，不再打服务端。
 *
 * 对外暴露 window.__zcrcSnetStats() 供探针验证（live/queue/dedup/hit 计数）。
 */

export function installSessionNet() {
  try {
    if (typeof window === 'undefined' || !window.fetch) return;
    var W = window;
    if (W.__zcrcSnetInstalled) return;
    W.__zcrcSnetInstalled = true;
    var origFetch = W.fetch; // 先存原生 fetch，补丁内部一律走它，防止自递归

    // 重接口特征：会话切换时官方前端连发的只读查询。
    var HEAVY_RE = /mnemon|turn-activities|agent-teams|dsh-purge/;
    var MAX_CONCURRENT = 3;
    var CACHE_TTL_MS = 800;
    var CACHE_MAX = 30;

    var stats = { live: 0, queued: 0, dedup: 0, hit: 0, done: 0 };
    var active = 0;
    var queue = []; // 等待起跑的 {start}
    var inflight = new Map(); // url -> Promise<Response 原始对象>
    var cache = new Map(); // url -> { at, res }（res 保持未消费，供 clone）

    function cacheGet(url) {
      var e = cache.get(url);
      if (!e) return null;
      if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(url); return null; }
      return e.res;
    }

    function cachePut(url, res) {
      try { cache.set(url, { at: Date.now(), res: res }); } catch (e) {}
      if (cache.size > CACHE_MAX) {
        var oldest = cache.keys().next().value;
        cache.delete(oldest);
      }
    }

    function pump() {
      if (active >= MAX_CONCURRENT || !queue.length) return;
      var next = queue.shift();
      stats.queued = queue.length;
      active++;
      stats.live = active;
      next();
    }

    function runLimited(url, init) {
      return new Promise(function (resolve, reject) {
        var started = false;
        function start() {
          started = true;
          origFetch(url, init).then(function (res) {
            active--;
            stats.live = active;
            stats.done++;
            resolve(res);
            pump();
          }, function (err) {
            active--;
            stats.live = active;
            reject(err);
            pump();
          });
        }
        if (active < MAX_CONCURRENT) { active++; stats.live = active; start(); }
        else { stats.queued = queue.length + 1; queue.push(start); }
        // 兜底：调用方若传入被中止的 signal，排队的这份直接放弃起跑。
        var sig = init && init.signal;
        if (sig) {
          var onAbort = function () {
            if (started) return;
            var i = queue.indexOf(start);
            if (i >= 0) { queue.splice(i, 1); stats.queued = queue.length; }
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (sig.aborted) onAbort();
          else sig.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    W.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method !== 'GET' || !HEAVY_RE.test(url)) return origFetch.apply(null, arguments);

        // 微缓存命中
        var cached = cacheGet(url);
        if (cached) { stats.hit++; return Promise.resolve(cached.clone()); }

        // 在途去重
        var shared = inflight.get(url);
        if (shared) { stats.dedup++; return shared.then(function (r) { return r.clone(); }); }

        var p = runLimited(url, init || undefined);
        inflight.set(url, p);
        var tracked = p.then(function (res) {
          inflight.delete(url);
          if (res.ok) cachePut(url, res);
          return res;
        }, function (err) {
          inflight.delete(url);
          throw err;
        });
        // 共享者拿到 clone，原始 Response 留给首个调用方之外的所有等待者
        return tracked.then(function (r) { return r.clone(); });
      } catch (e) {
        return origFetch.apply(null, arguments);
      }
    };

    W.__zcrcSnetStats = function () { return JSON.parse(JSON.stringify(stats)); };
  } catch (e) { /* 静默：调度器绝不能弄坏页面 */ }
}
