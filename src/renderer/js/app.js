/**
 * 网页窗口合集 · 渲染层主逻辑
 */
(function () {
  'use strict';

  /*
   * 静态资源基址。
   *
   * Electron 版从 src/renderer/index.html 加载，assets/ 就在同目录，基址留空即可。
   * h5 演示版从 h5/index.html 加载，同一份 app.js 被跨目录引用，
   * 页面必须先把 window.__ASSET_BASE 设成 '../src/renderer/'，
   * 否则道具图标与 logo 会按 h5/assets/ 去取，全部 404。
   */
  const ASSET_BASE = (typeof window !== 'undefined' && window.__ASSET_BASE) || '';

  /*
   * 全局错误捕获（自检与排障用）。
   *
   * 为什么要加：这个项目反复出现「界面卡住但没人知道为什么」。
   * 渲染层一旦抛异常，界面表现只是「不动了」，
   * 控制台报错又被折叠起来，最终只能靠用户口头描述现象 ——
   * 而用户能说的往往只有「卡住了」，拿不到真正的现场信息。
   *
   * 这里把未捕获异常与Promise 拒绝都攒起来，
   * 自检脚本可以直接读 window.__selfcheckErrors 断言「渲染层无异常」，
   * 不再需要靠猜。
   */
  window.__selfcheckErrors = [];

  /*
   * 用赋值式 onerror 而不是 addEventListener：
   *   单元测试的 mock window 只有 onerror、没有 addEventListener，
   *   直接调addEventListener 会让整个模块加载失败。
   *   赋值式两种环境都能工作，代价是不能多个监听器，但这里只需要一个。
   */
  window.onerror = function (msg, src, line) {
    try {
      window.__selfcheckErrors.push('error: ' + msg + ' @' + src + ':' + line);
      if (window.__selfcheckErrors.length > 30) window.__selfcheckErrors.shift();
    } catch (e) { /* 收集失败也不能影响主流程 */ }
    return false; // 不阻断默认行为
  };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      try {
        window.__selfcheckErrors.push(
          'unhandledrejection: ' + ((r && (r.message || r)) || String(r))
        );
        if (window.__selfcheckErrors.length > 30) window.__selfcheckErrors.shift();
      } catch (x) { /* 同上 */ }
    });
  }

  const CHARACTERS = window.AI_TAMER_CHARACTERS.CHARACTERS;
  const KIND_LABEL = window.AI_TAMER_CHARACTERS.KIND_LABEL;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  /*
   * 早到帧的暂存区。
   *
   * 主进程连接成功后立刻开始推帧，而渲染层的会话登记要等
   * sessionConnect 的 Promise resolve —— 中间存在一个时间差，
   * 这段时间到达的帧找不到对应会话就没法渲染。
   * 过去这些帧被直接丢弃，于是界面卡在等待态（详见 capture:frame 处的说明）。
   */
  const pendingFrames = Object.create(null);

  /*
   * 辅助功能权限的全局缓存（null = 还没查过）。
   *
   * ⚠ 权限是**整个App 一份**的，不该每个会话各查一次：
   *   每张卡都查会产生重复 IPC，而且多张卡同时接入时状态还可能打架。
   *   缓存起来顺便当作「是否已查过」的标记。
   */
  let axGlobal = null;

  /*
   * 自检用的调试出口。
   * 自检脚本跑在渲染层里（主进程 executeJavaScript），
   * 需要能看到内部状态才能定位问题 ——
   * 「界面没画面」可能是帧没到、卡没渲染、或选择器变了，
   * 光看结果无法区分。
   * 正常使用时无人读取，无副作用。
   */
  window.__scDebug = () => ({
    sessions: Object.keys(sessions || {}),
    sessionCount: Object.keys(sessions || {}).length,
    pendingSids: Object.keys(pendingFrames),
    pendingLens: Object.keys(pendingFrames).map((k) => (pendingFrames[k].dataUrl || '').length),
    frameLens: Object.keys(sessions || {}).map((k) => ({
      sid: k,
      channel: sessions[k].channel,
      hasFrame: !!sessions[k].frameData,
      len: (sessions[k].frameData || '').length
    }))
  });

  /**
   * 把一帧画到卡片的捕获区里。
   *
   * 单独抽出来的原因：既要能被「帧事件」调用（会话已登记），
   * 也要能被「会话登记完成」调用（回填早到的帧），
   * 两条路径必须走同一份逻辑，否则迟早会出现一边生效一边不生效。
   */
  function applyFrameToCard(sid, s) {
    const hole = document.querySelector(`.capture-hole[data-capture="${sid}"]`);
    if (!hole) return false;
    let img = hole.querySelector('.capture-img');
    if (!img) {
      // 首帧：之前还在「正在捕获」占位，补上真正的画面
      const nm = nameOf(s && s.appId);
      hole.innerHTML = `<img class="capture-img" alt="${escapeAttr(nm)} 的实时画面" />`;
      img = hole.querySelector('.capture-img');
      if (!img) return false;
    }
    const pf = pendingFrames[sid];
    const src = (s && s.frameData) || (pf && pf.dataUrl) || '';
    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    return !!img;
  }

  /*
   * 按 id 找角色定义。
   *
   * 为什么要分两处找：CHARACTERS 是内置 14 个 AI 的静态数组，
   * 而用户可以自己添加任意本地应用（微信、Notion…），
   * 那些角色只存在于主进程推来的 S.chars 里。
   * 只查静态数组的话，自定义角色在界面上一律渲染不出来。
   */
  const byId = (id) => {
    const def = CHARACTERS.find((c) => c.id === id);
    if (def) return def;
    return S && Array.isArray(S.chars) ? S.chars.find((c) => c.id === id) || null : null;
  };

  /*
   * 某个 AI 当前该用哪个「角色形象」来画。
   * 快照 char.skin 是主进程给的用户选择（未挑过 = 自己）；
   * 返回被选中形象的完整定义（art 底图 + pets/<id>/ 表情包目录都跟着它走），
   * 台词/性格等逻辑数据仍然用 AI 自己的，换皮只换画皮。
   */
  function skinOf(id) {
    const c = S && Array.isArray(S.chars) ? S.chars.find((x) => x.id === id) : null;
    const skinId = (c && c.skin) || id;
    if (skinId === id) return byId(id);
    return byId(skinId) || byId(id);
  }

  /** 是否为用户自己添加的应用（界面据此显示「移除」入口） */
  const isCustom = (id) => {
    const c = byId(id);
    return !!(c && c.custom);
  };

  /**
   * 界面上「全部角色」的运行时列表：内置 + 用户自定义。
   * 凡是要遍历角色的界面（角色框、任务创建、图鉴）都用它，
   * 不要直接用静态 CHARACTERS，否则自定义应用不会出现。
   */
  const allChars = () =>
    S && Array.isArray(S.chars) && S.chars.length ? S.chars : CHARACTERS;

  // 伤害数值只用于「拿不到真实扣血差值时」的飘字兜底，真实数值以引擎返回的 hpDelta 为准。
  // 这里与 engine.js 的 TOOLS 保持一致（2026-10-12 武器伤害已 ÷10）。
  // ico：emoji 仅作角色框角落等纯文本位置的兜底提示；
  // 道具栏直接用 assets/tools/<id>.png 平面展示图（用户提供的道具总览图切出）。
  //
  // locked 是付费墙（2026-10-15 定价：1元/个，全部 6 元）：
  // 徒手 / 拖鞋 两件永久免费，其余六件（皮鞭/水枪/BB弹枪/加特林/雷罚/投喂咖啡）单卖。
  // 解锁状态可以按件记（见 ownedTools），见 js/pay.js。
  const TOOLS_DEF = [
    { id: 'normal',  ico: '🖐', name: '徒手', hint: '摸摸它', dmg: 0 },
    { id: 'slipper', ico: '🩴', name: '拖鞋', hint: '东方家法', dmg: 1.7, heal: false },
    { id: 'whip',    ico: '🪢', name: '皮鞭', hint: '经典款', dmg: 1.2, heal: false, locked: true },
    { id: 'water',   ico: '🔫', name: '水枪', hint: '湿身 Bureau', dmg: 0.5, heal: false, locked: true },
    { id: 'gun',     ico: '🔫', name: 'BB 弹枪', hint: '有点疼', dmg: 2.4, heal: false, locked: true },
    { id: 'gatling', ico: '🌀', name: '加特林', hint: '倾泻火力', dmg: 4.0, heal: false, locked: true },
    { id: 'thunder', ico: '⚡', name: '雷罚', hint: '天降正义', dmg: 3.2, heal: false, locked: true },
    { id: 'coffee',  ico: '☕', name: '投喂咖啡', hint: '回血·降压力', dmg: -20, heal: true, locked: true }
  ];

  /*
   * 解锁状态（只有 locked 的道具在乎它）。
   *
   * 初始值写死 false：宁可先亮一下锁、拿到主进程结论再放行，
   * 也不能先放行再收回 —— 后者等于每次启动都开一个白嫖窗口。
   * 真相只有主进程的 license.json 说了算，渲染层不存任何授权。
   * unlocked = 全部解锁；ownedTools = 单买的道具（1元/个那档）。
   */
  let unlocked = false;
  let ownedTools = [];
  let lastLocked = null; // 最近一次被点开的锁定道具，解锁后自动切到它

  /** 某件道具是否已解锁：全部解锁算数，单买的也算数 */
  function owns(id) {
    return unlocked || ownedTools.indexOf(id) >= 0;
  }

  function loadLicense() {
    return (async () => {
      try {
        const st = await window.api.licenseState();
        unlocked = !!(st && st.unlocked);
        ownedTools = (st && st.ownedTools) || [];
      } catch (e) {
        // 拿不到授权状态就按「未解锁」处理：失败方向永远偏向保守
      }
    })();
  }

  function initPay() {
    if (!window.AI_TAMER_PAY) return;
    window.AI_TAMER_PAY.mount({
      modal,
      onUnlocked: () => {
        // 解锁可能只买了单件：以主进程 license.json 的最新结论为准
        loadLicense().then(() => {
          buildToolbar();
          if (lastLocked && owns(lastLocked.id)) setTool(lastLocked.id);
          render(S);
        });
      }
    });
  }

  function openUnlock(def) {
    lastLocked = def || null;
    if (!window.AI_TAMER_PAY) {
      // 弹窗模块没加载（理论上不会发生）也不能让点击静默无效
      if (typeof toast === 'function') toast('解锁模块没加载起来，重启一下 App');
      return;
    }
    window.AI_TAMER_PAY.open(def);
  }

  /*
   * 状态文案（2026-10-12 起，造型由血条档位决定，文案跟着档位走）：
   *   满血=开心 / 80=待命 / 60=搬砖 / 40 以下=求饶 / 0=阵亡
   */
  const STATE_LABEL = {
    idle: '待命', working: '搬砖', beg: '求饶', joy: '开心', down: '阵亡', weak: '虚弱', focus: '专注'
  };

  /** 情绪 → 强调色（卡片顶条 / 状态文字统一用它） */
  const TONE = {
    idle: '',
    working: '#2F4BD8',
    beg: '#A8432A',
    down: '#BDB5A8',
    joy: '#2E6B4F',
    weak: '#B07A1E',
    focus: '#2F4BD8'
  };

  let S = null;              // 最新快照
  let tool = 'whip';
  // view（视图筛选）已随侧栏那一块删除。它本来只是把卡片按任务状态过滤，
  // 而顶部角色框已经能精确选中单个 AI，筛选器是重复功能。
  let selected = null;       // 选中的角色 id
  let fx = null;
  let lastHitAt = {};

  /* ---- 本机 AI 连接状态（无需 API Key） ---- */
  let scan = null;           // 扫描结果：{ results:{id:[通道]}, best:{id:首选} }
  let sessions = {};         // sid -> {sid, appId, name, status, lines:[]}
  let activeSid = null;      // 当前正在看的会话
let watchTarget = null;    // 产物观察：当前观察的目录
let watchSid = null;       // 产物观察：对应的会话 id
let watchAppId = null;     // 产物观察：归属的角色 id
let watchProgress = null;  // 产物观察：最近一次进度

/**
 * 弹窗打开时为 true —— 期间所有内嵌视图（原生层）必须收成 0 尺寸。
 * WebContentsView 不受 DOM z-index 约束，压在弹窗上，只能靠尺寸收掉。
 */
let embedsSuppressed = false;

/* ---- 监视器卡片排序（长按标签条空白处拖动改序） ---- */
const WALL_ORDER_KEY = 'aiTamer.wallOrder.v1';
let wallOrder = (() => {
  try { const v = JSON.parse(localStorage.getItem(WALL_ORDER_KEY)); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
})();
/** 拖动进行中：{ appId, el, ghost, dx, dy }；release 后置回 null */
let wallDrag = null;
/** 拖完松手的那一下会冒出一个 click —— 短暂吞掉，免得误触发「单卡填满」 */
let justDragged = false;

/** 卡片在用户自定排序里的位次；没排过的排在已排的后面（稳定排序保住原有相对顺序） */
function wallOrderRank(id) {
  const i = wallOrder.indexOf(id);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}


  /** 某个角色当前是否有活跃会话 */
  function sessionOf(appId) {
    const sid = Object.keys(sessions).find((k) => sessions[k].appId === appId && sessions[k].status !== 'closed');
    return sid || null;
  }

  /**
   * 界面上显示的 AI 名称。
   *
   * ⚠ 不要再直接用 c.name（蛋总 / 月牙君 / 豆包醬）—— 那是早期我们自己起的
   * 昵称，用户在一堆真实 AI 应用里根本对不上号，选择成本很高。
   * 现在统一走主进程算好的 displayName：
   *   用户自定义名 > 本机 .app 真实显示名 > 系统默认名
   * CHARACTERS 是静态定义，拿不到运行时的 displayName，所以要回 S.chars 里找。
   */
  function nameOf(id) {
    if (S && Array.isArray(S.chars)) {
      const c = S.chars.find((x) => x.id === id);
      if (c && c.displayName) return c.displayName;
    }
    const def = byId(id);
    return (def && def.app) || id;
  }

  /** 同上，但接受一个可能来自 S.chars 的对象 */
  function nameOfChar(c) {
    if (!c) return '';
    return c.displayName || c.app || c.name || c.id;
  }

  function curSession() {
    return activeSid ? sessions[activeSid] : null;
  }

  /* ---------------- 初始化 ---------------- */

  async function boot() {
    fx = new Effects($('#fx'), { shake: true });
    fx.resize();
    fx.start();
    bindLogoFallback();

    /*
     * 角色 IP 位图探测完成 → 强制重建一次角色框。
     * 角色 HTML 只在结构签名变化时重建，而首帧渲染时「哪些状态有用户
     * 自绘图」的探测还没完成，框里可能定格了程序贴纸回落路径；
     * characters.js 在探测全部落定后广播 petassetsready，这里清掉签名
     * 重建一次，让 hitimg（用户的被打图）层真正就位、老贴纸彻底消失。
     */
    document.addEventListener('petassetsready', () => {
      rosterSig = '';
      render(S);
    });

    /*
     * 顶栏版本号。
     *
     * 来源是 package.json（主进程 app.getVersion()），**不在渲染层写死字符串**：
     * 这个数字是用户判断「我打开的到底是不是刚同步进来的新版」的唯一依据，
     * 而本项目「改完必须 sync:install」是铁律 —— 写死版本号，
     * 就会出现「档案写着 1.01、界面显示 0.1.0」这种自相矛盾，
     * 用户据此误判「同步没生效」，然后重复同步、重复排查。
     *
     * 失败也不影响启动：拿不到就不显示，不留半个 'v'。
     */
    (async () => {
      try {
        const v = await window.api.appVersion();
        const el = $('#tb-ver');
        if (el && v) el.textContent = 'v' + v;
      } catch (e) { /* 版本号拿不到不是致命问题，静默 */ }
    })();

    /*
     * 【已移除 · 2026-10-10】启动即预检辅助功能权限。
     *
     * 这里原来有一段 `window.api.captureAX()` 预检，外加把结果写回所有会话。
     * 它解决的是一个真实的死锁，留档在此，别再踩：
     *
     *   死锁链条（这个坑让用户完全找不到授权入口）：
     *     ensureAX() 只在 hole 的 mouseup 里被调用，
     *     而用户之所以点画面，正是因为「点了没反应」；
     *     没反应就不会触发检查，不检查就不知道缺权限，
     *     不知道缺权限界面就不会显示按钮，用户于是找不到入口。
     *   也就是说：**触发检查的条件，恰好是问题不发生的条件。**
     *
     * 为什么删：产品已收敛为「只内嵌网页版」，画面与输入都在 WebContentsView
     * 里完成，不再需要辅助功能 / 屏幕录制权限；preload.js 也不再暴露 captureAX。
     * 删掉入口却留下这段预检调用，App 一启动就会抛 TypeError —— 必须一起删。
     *
     * ⚠ 不要把这段预检单独加回来。真要恢复桌面捕获方案，
     *   必须连 preload.js + index.js 的 IPC 一起恢复；
     *   完整可运行的旧方案备份在 .backups/current-capture-control-20261010。
     *   对应守护测试见 scripts/test-ax-entry.js 的【4】。
     */
    // 拖动窗口时给 body 挂 .resizing：关掉全屏噪点层、停掉跑马灯动画。
    // 这两层在 resize 期间每帧都要按新尺寸重新光栅化，是白屏/花屏的重要推手。
    // rAF 合并 + 停 200ms，保证「连续拖动」期间一直保持降载态。
    let rzRaf = 0;
    let rzTimer = 0;
    const markResizing = () => {
      document.body.classList.add('resizing');
      if (rzRaf) return;
      rzRaf = requestAnimationFrame(() => {
        rzRaf = 0;
        fx.resize();
        syncEmbedBounds();
      });
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        document.body.classList.remove('resizing');
        // ⚠ 必须在恢复显示之后再量一次尺寸。
        //   降载期间 #fx 是 display:none，clientWidth 为 0，
        //   fx.resize() 会直接跳过（这是有意的保护）；
        //   如果这里不补一次调用，画布就会停留在拖动之前的尺寸，
        //   特效会被拉伸变形 —— 属于「降载本身引入的新 bug」。
        //   等一帧是为了让 display 恢复先完成布局。
        requestAnimationFrame(() => {
          fx.resize();
          syncEmbedBounds();
        });
      }, 200);
    };
    window.addEventListener('resize', markResizing);

    // 解锁状态必须在道具栏第一次渲染前拿到，否则会先亮一下锁再放行
    await loadLicense();
    initPay();

    buildToolbar();
    initSizeControl();
    bindGlobal();
    trackCursor();
    // 开局就把武器光标下发一次，否则第一次进角色框区要等 mousemove 才显示武器
    applyToolCursor();
    // 提前解码真实录音素材（皮鞭/拖鞋/加血），不等第一次打击才开始解
    if (window.SFX && typeof window.SFX.preload === 'function') window.SFX.preload();

    S = await window.api.boot();
    applySettings();
    render(S);

    window.api.onTick((snap) => {
      S = snap;
      render(snap);
    });

    // 实时会话事件：只刷对应那张卡的输出，不重建 DOM
    window.api.onSession((evt) => {
      if (evt.type === 'session:line') {
        const s = sessions[evt.sid];
        if (!s) return;
        s.lines.push(evt.line);
        if (s.lines.length > 800) s.lines.splice(0, s.lines.length - 800);
        updateVcardLines(s.appId);
      } else if (evt.type === 'session:state' || evt.type === 'session:closed') {
        const s = sessions[evt.sid];
        if (s) s.status = evt.status || 'closed';
        /*
         * 把失败原因与只读状态一并同步过来。
         *
         * 踩过的坑：这里原来只同步 status，
         * 于是主进程明明已经知道「系统拒绝了截图」并写好了 capNote，
         * 界面却拿不到 —— 只能继续显示「正在捕获窗口画面…」，
         * 用户等多久都没用。**状态事件必须把「为什么失败」也带上。**
         */
        if (s && evt.capNote !== undefined) s.capNote = evt.capNote;
        if (s && evt.readonly !== undefined) s.readonly = !!evt.readonly;
        /*
         * 窗口几何也要跟着走。
         * 用户随时可能拖动/缩放那个 App 的窗口，主进程每次控制前会刷新坐标，
         * 这里同步一份是为了让界面状态与真实窗口一致 ——
         * 否则「挪一下窗口，之后点哪儿都偏」，极难定位。
         */
        if (s && evt.winRect) s.winRect = evt.winRect;
        if (s && evt.streamMode) s.streamMode = evt.streamMode;
        // 注入模式由主进程裁决，界面只跟随显示（避免两边各自维护一份状态）
        if (s && evt.inputMode) s.inputMode = evt.inputMode;
        if (s && evt.embedKey) s.embedKey = evt.embedKey;
        if (s && evt.embedTabs) s.embedTabs = evt.embedTabs;

        /*
         * 捕获会话一旦建立就**主动**查一次辅助功能权限。
         *
         * ⚠ 为什么不等到用户点击画面时再查：
         *   那时候用户已经「点了没反应」，才会看到提示 ——
         *   但他此刻无法判断是权限问题还是程序坏了。
         *   提前把「开启鼠标操作」摆在工具条上，
         *   缺权限这件事在**动手之前**就是可见的。
         *
         * 而且权限是全局的、整个App 一次就够，
         * 所以只查一次并缓存到全局，不必每张卡各查一遍。
         */
        if (evt.type === 'session:closed') {
          delete sessions[evt.sid];
          if (s) connected.delete(s.appId);
        } else if (s && evt.status === 'live') {
          connected.add(s.appId);
        }
        if (s) {
          // 状态变了要重画整张卡（输入条是否出现会变）
          if (S) renderWall(S);
          renderRoster();
          if (S) renderMini(S); // 接入/断开集合变了，侧栏同步刷
        }
      } else if (evt.type === 'session:snapshot') {
        // 内嵌网页 / Electron 内壳：整体界面文本刷新
        const s = sessions[evt.sid];
        if (!s) return;
        s.lines = evt.lines;
        updateVcardLines(s.appId);
      } else if (evt.type === 'embed:state') {
        // 内嵌视图加载/跳转/失败的状态回执
        const key = evt.key;
        const s = Object.values(sessions).find((x) => x.embedKey === key);
        if (s) {
          if (evt.needsLogin) {
            s.needsLogin = true;
            toast(`${s.name} 需要先在内嵌画面里登录一次`);
          }
          if (S) renderWall(S);
        }
      } else if (evt.type === 'embed:closed') {
        // 视图被销毁：把对应会话标记掉，卡片退回待机态
        const s = Object.values(sessions).find((x) => x.embedKey === evt.key);
        if (s && !(s.embedTabs && s.embedTabs.length > 1)) {
          connected.delete(s.appId);
          delete sessions[s.sid];
          if (activeSid === s.sid) activeSid = null;
          if (S) renderWall(S);
          renderRoster();
          if (S) renderMini(S); // 内嵌视图销毁 = 断开，侧栏同步刷
        }
      } else if (evt.type === 'embed:realign') {
        // 窗口尺寸/缩放变了，重新贴合所有内嵌视图
        syncEmbedBounds();
      } else if (evt.type === 'embed:fullscreen') {
        /*
         * 内嵌页面自己进了/退了全屏（视频播放器的全屏按钮那类）。
         *
         * 用户拍板的口径：全屏只发生在监视器自己的画面区里 ——
         * 页面进全屏后 Chromium 把全屏元素画满视口，视口就是卡片画面区，
         * 主进程**不改任何尺寸**，所以渲染层同样不需要动布局。
         *
         * 唯一要做的事在**退出**时：全屏过渡可能让 macOS 重组窗口的
         * contentView、把内嵌视图整个摘下来（用户实测「退出全屏后全部
         * 空白」）。主进程会重挂载视图，这里再连补几轮贴合，
         * 把所有画面的位置坐标重新对齐。
         */
        if (!evt.on) {
          syncEmbedBounds();
          setTimeout(syncEmbedBounds, 120);
          setTimeout(syncEmbedBounds, 450);
          setTimeout(syncEmbedBounds, 1000);
        }
      } else if (evt.type === 'capture:frame') {
        /*
         * 本地桌面 App 的窗口捕获帧。
         * 只换 <img> 的 src，不重建 DOM —— 否则每秒重建一次会把
         * 图片重新加载成闪烁的样子，也会打断用户正在输入的文字。
         *
         * ⚠ 时序陷阱（自检实测抓到的真实 bug）：
         *   主进程在 connectApp 里**同步**调用 startCaptureLoop，
         *   而后者会立即执行一次 tick() 把首帧发出来。
         *   但渲染层的 sessionConnect 是 await 的 ——
         *   等 Promise resolve、sessions[sid] 写进去时，早期帧已经丢了。
         *   结果就是：后端明明status=live、winId有效，
         *   界面却一直停在「正在捕获窗口画面…」，快照里帧也是空的。
         *   这正是「测试全绿但用户说卡住」的典型形态。
         *
         * 修法：会话还没登记时先把帧存下来，
         * 会话登记完成后再回填。不必让主进程等渲染层，
         * 两侧各自按自己的节奏走。
         */
        pendingFrames[evt.sid] = { dataUrl: evt.dataUrl, at: evt.at };

        const s = sessions[evt.sid];
        if (!s) return; // 会话还没登记，帧已缓存，等登记后回填
        s.frameAt = evt.at;
        s.frameData = evt.dataUrl;
        applyFrameToCard(evt.sid, s);
      } else if (evt.type === 'session:watch') {
        // 产物观察：把推断出的进度直接绑到对应角色的卡上
        const s = sessions[evt.sid];
        if (!s) return;
        s.progress = evt.progress;
        s.reasons = evt.reasons;
        s.git = evt.git;
        watchProgress = evt.progress;
        if (s.appId) updateVcardLines(s.appId);
        renderRoster();
      }
    });

    /*
     * 开局的两件重活：恢复连接 + 扫描本机。
     *
     * ⚠ 都不能 await —— 之前的写法是
     *     await restoreSessions(); await doScan(true);
     * 于是启动时要等「逐个重连」（每个站点一次完整 loadURL，两三个站点
     * 就是 2~3 秒）跑完，界面才继续往下走，用户看到的就是「进来要等 3 秒」。
     * 现在两件事并行丢到后台，界面立刻可用，恢复完一帧内长出来。
     */
    restoreSessions();
    doScan(true);
  }

  /**
   * 刷新后把界面恢复回去。
   *
   * 之前 ⌘R 会「所有页面清空」：渲染层的 sessions 是纯内存的，页面一重载就没了，
   * 但主进程里的会话、内嵌 WebContentsView、CLI 子进程全都还活着 ——
   * 于是界面上一片空白，而 AI 其实还在跑。
   *
   * 现在启动时向主进程要一次全量快照，把 sessions 映射、connected 集合
   * 和正在观察的目录一起重建，刷新后就只是「重画」而不是「清空」。
   *
   * 2026-10-12 起优先走 sessionRestore：完全退出再打开时主进程的会话已经不在了，
   * 它会按存档里的「已接入」清单把网页版逐个重连（⌘R 场景下则原样收编存活会话）。
   */
  async function restoreSessions() {
    if (!window.api.sessionSnapshots) return;

    /*
     * ⚠ 分两步走，顺序很关键（启动 3 秒等待的根治）：
     *
     *   ① 先要一次**内存快照**（sessionSnapshots）—— 纯内存整理，毫秒级返回。
     *      界面立刻把上一轮的监视器画出来，用户不再盯着空壳等。
     *   ② 再后台跑 sessionRestore —— 它会真的逐个重连网页版
     *      （每个站点一次完整 loadURL），几十毫秒到几秒都有可能，
     *      但完全不影响界面已经可用这件事；连好一个就补画一个。
     *
     * 之前是直接 await sessionRestore() 拿结果才开始画，
     * 等于把「重连耗时」整个压在了启动路径上。
     */
    let list = [];
    try {
      list = await window.api.sessionSnapshots();
    } catch (e) { /* 快照拿不到就走下面的后台恢复 */ }
    if (Array.isArray(list) && list.length) applySnapshots(list);

    if (!window.api.sessionRestore) return;
    window.api.sessionRestore().then((full) => {
      if (!Array.isArray(full) || !full.length) return;
      // 恢复结果整体覆盖一次（幂等）：新增的会话、以及后端修正过的状态都跟上
      applySnapshots(full);
    }).catch(() => {});
  }

  /**
   * 把主进程给的会话快照铺到界面上（可重复调用，幂等）。
   */
  function applySnapshots(list) {
    if (!Array.isArray(list) || !list.length) return;
    const known = new Set(Object.keys(sessions));
    list.forEach((s) => {
      if (!s || !s.sid || !s.appId) return;
      sessions[s.sid] = {
        sid: s.sid,
        appId: s.appId,
        channel: s.channel || 'url',
        name: s.name || '',
        status: s.status,
        readonly: !!s.readonly,
        // 刷新后也要保留失败原因与帧，否则界面会退回「正在捕获…」的假等待
        capNote: s.capNote || '',
        winId: s.winId || 0,
        pid: s.pid || 0,
        appName: s.appName || '',
        frameData: s.frameData || '',
        frameAt: s.frameAt || 0,
        embedKey: s.embedKey || '',
        embedUrl: s.embedUrl || '',
        embedTabs: Array.isArray(s.embedTabs) ? s.embedTabs : [],
        needsLogin: !!s.needsLogin,
        startedAt: s.startedAt,
        lines: Array.isArray(s.lines) ? s.lines.slice() : [],
        progress: null,
        reasons: null,
        git: null
      };
      connected.add(s.appId);
      // watch 通道的观察目录主进程还在，重新挂上方便继续显示进度
      if (s.channel === 'watch' && !watchSid) watchSid = s.sid;
    });

    // 卡片要立刻能画出来，但内嵌原生视图的坐标要等 DOM 布局完才知道
    // renderMini 也要跟上（2026-10-13 用户反馈：恢复会话后顶部角色框齐了，
    // 左侧「角色展示」却迟迟不长出来 —— 引擎空闲时不推 tick，侧栏就一直缺）。
    if (S) {
      renderRoster();
      renderMini(S);
      renderWall(S);
    }
    /*
     * 贴合时机要给足：内嵌 WebContentsView 从创建到页面加载完成需要时间，
     * 只在 120/420ms 贴两次，页面还没加载完时算出的位置可能不准。
     * 多补两次长延迟的 —— 迟到比不贴好（不贴就是 0×0，用户看到的就是
     * 「连接丢了」：后端 live、界面空白）。
     */
    setTimeout(syncEmbedBounds, 120);
    setTimeout(syncEmbedBounds, 420);
    setTimeout(syncEmbedBounds, 900);
    setTimeout(syncEmbedBounds, 1800);
    // 让用户知道恢复发生了：只说**这次新恢复出来**的数量。
    // 内存快照那一步（启动瞬间）通常已经画出一批，不能重复播报，
    // 否则「已自动恢复 2 个连接」会连播两次。
    // 真的一个都没恢复时，主进程的 restore.log 里有每一步失败原因
    // （userData/restore.log）。
    const added = list.filter((s) => s && s.sid && !known.has(s.sid)).length;
    if (added) toast('已自动恢复 ' + added + ' 个连接');
  }

  /**
   * 扫描本机 AI 应用
   */
  async function doScan(silent) {
    try {
      scan = await window.api.scanLocal();
      const n = Object.keys(scan.best).filter((k) => scan.best[k]).length;
      if (!silent) toast(`扫描完成：${n} 个角色可连接`);
      if (S) renderWall(S);
      renderRoster();
    } catch (e) {
      // 静默扫描也可能失败（比如主进程某个处理器抛错），
      // 必须留个痕迹，否则界面上只会看到「暂无内置网页版」却查不到原因
      console.error('[scan] 本机扫描失败：', e);
      if (!silent) toast('扫描失败：' + e.message);
    }
  }

  /**
   * 连接某个角色
   */
  async function doConnect(appId, kind) {
    const def = byId(appId);
    if (!def) return;

    // 已连接则先断开
    const exist = sessionOf(appId);
    if (exist) {
      await window.api.sessionDisconnect(exist);
      delete sessions[exist];
      connected.delete(appId);
      if (activeSid === exist) activeSid = null;
      if (S) renderWall(S);
      renderRoster();
      if (S) renderMini(S); // 断开也要同步侧栏，别等下一个 tick
      toast('已断开 ' + nameOf(appId));
      return;
    }

    toast('正在连接 ' + nameOf(appId) + ' …');

    /*
     * kind 来自接入面板的按钮：'app' = 走本机窗口捕获，
     * 'embed' = 走内嵌网页，'auto'/空 = 交给主进程挑最佳通道。
     * 必须显式传通道，否则主进程永远选 embed，本机 App 那条路就永远走不到。
     */
    let payload = { appId, task: { prompt: '' } };
    const webDef = S && S.chars && S.chars.find((c) => c.id === appId && c.customWeb);
    if (webDef && webDef.url) {
      payload.channel = { kind: 'embed', name: webDef.displayName || webDef.name || webDef.url,
        site: { url: webDef.url, title: webDef.displayName || webDef.name || webDef.url, login: true },
        url: webDef.url, interactive: true };
    } else {
      payload.channelKind = 'embed';
    }
    const res = await window.api.sessionConnect(payload);
    const sid = res.sid;
    if (!sid) return;

    sessions[sid] = {
      sid,
      appId,
      channel: res.channel || 'url',   // 决定卡内能否输入
      name: res.name || nameOf(appId),
      status: res.status,
      readonly: res.readonly,
      // 失败原因必须一起带回来：连接返回时如果已经知道抓不到画面，
      // 界面才能立刻显示正确提示，而不是先显示「正在捕获…」再慢慢转圈
      capNote: res.capNote || '',
      winId: res.winId || 0,
      pid: res.pid || 0,
      embedKey: res.embedKey || '',
      embedUrl: res.embedUrl || '',
      embedTabs: Array.isArray(res.embedTabs) ? res.embedTabs : [],
      // 注入模式：'direct' 直投（不抢光标）| 'front' 全局兜底
      inputMode: res.inputMode || 'front',
      needsLogin: res.needsLogin || false,
      lines: res.lines || []
    };
    activeSid = sid;
    /*
     * 回填早到的帧。
     * 主进程在 connect 返回前就已经推过帧了，
     * 那些帧当时找不到会话只能暂存（见 pendingFrames 说明）。
     * 现在会话登记好了，把缓存的那一帧补上，
     * 否则要白等一个周期才出画面 —— 严重时看起来就像卡住了。
     */
    const early = pendingFrames[sid];
    if (early) {
      sessions[sid].frameAt = early.at;
      sessions[sid].frameData = early.dataUrl;
    }
    // 只要真的建立了会话就算「已接入」——抽打门禁认的是这个，
    // 不能只在内嵌通道时才记，否则 CLI / 观察通道会被误判成未接入。
    connected.add(appId);

    if (res.status === 'failed') toast('连接失败：' + nameOf(appId));
    else toast('已接入 ' + nameOf(appId) + ' · 实时画面已开');

    if (S) renderWall(S);
    renderRoster();
    // 侧栏与顶部角色框同步：引擎空闲时不推 tick，
    // 这里不主动刷的话，新接入的角色在左侧「角色展示」里要等到下一次
    // 快照（可能几分钟之后）才出现 —— 用户 2026-10-13 实测踩中。
    if (S) renderMini(S);

    // 内嵌视图建好后要马上贴合卡片位置，否则会短暂停在 0 尺寸
    if (res.channel === 'embed') {
      setTimeout(syncEmbedBounds, 300);
      setTimeout(syncEmbedBounds, 1200);
    }
  }

  /**
   * 已成功接入的角色。
   *
   * 抽打必须建立在「先连接」之上：一个都没接入时点角色，
   * 只是在打一个不存在的进程，没有意义。所以未接入时直接拦下来并引导去连接。
   */
  const connected = new Set();

  /**
   * 往当前会话写输入
   */
  async function sendToSession(text) {
    const s = curSession();
    if (!s || !text) return;
    if (s.status === 'closed') return toast('会话已结束');
    const r = await window.api.sessionWrite(s.sid, text);
    if (r && r.ok === false) toast(r.msg || '写入失败');
    updateVcardLines(s.appId);
  }

  function applySettings() {
    document.body.classList.toggle('theme-night', S && S.settings.theme === 'night');
    SFX.setEnabled(!S || S.settings.sfx !== false);
  }

  /* ---------------- 底部道具栏 ---------------- */

  function buildToolbar() {
    const box = $('#toolbar');
    if (!box) return;
    box.innerHTML = TOOLS_DEF.map((t) => {
      /*
       * 锁定态：locked 且尚未解锁才算锁上。
       * 锁标挂在小图标右下角（不遮道具本体），副标题换成一句说明 ——
       * 在图标上盖一个大锁会把这排精心画的道具图全糊掉，得不偿失。
       */
      const lock = !!t.locked && !owns(t.id);
      const tip = lock ? '未解锁 · 点一下看看怎么解锁' : `${t.hint}（快捷键 ${TOOLS_DEF.indexOf(t) + 1}）`;
      return `<button class="tool ${t.id === tool && !lock ? 'active' : ''} ${t.heal ? 'heal' : ''} ${lock ? 'locked' : ''}" data-tool="${t.id}"
           title="${tip}">
           <span class="ico"><img class="tico" src="${ASSET_BASE}assets/tools/${t.id}.png" alt="${t.name}" draggable="false">${lock ? '<span class="lockbadge"></span>' : ''}</span>
           <span><span class="lbl">${t.name}</span><span class="dmg">${lock ? '点我解锁' : t.hint}</span></span>
         </button>`;
    }).join('');

    $$('.dock-tools .tool').forEach((b) => {
      b.onclick = () => setTool(b.dataset.tool);
    });
  }

  /**
   * 光标系统 —— 作用域完全交给 CSS，JS 只下发「当前武器的图形」这一个变量。
   *
   * 为什么不再用 JS 写 inline cursor：
   *   之前每次 mousemove 都往 documentElement/body 上写 cursor 字符串，
   *   一是覆盖了内层所有 cursor 规则（连按钮的 pointer 都被吃掉），
   *   二是切武器时要等下一次 mousemove 才生效，看起来「换不干净」。
   * 现在切武器只改 --tool-cursor 一次，浏览器自己接管，
   *   鼠标停在原地不动也能立刻换成新武器 —— 这就是无缝。
   *
   * 作用域（写死在 styles.css，这里只做变量下发）：
   *   绿框 .roster     → 武器光标（唯一允许出现鼠标动画的地方）
   *   红框 .wall-wrap  → 系统正常鼠标，!important 堵死
   */
  const HOVER_RESET = 'default';

  function setTool(id) {
    const def = TOOLS_DEF.find((x) => x.id === id);
    /*
     * 锁定道具：点它不开打，而是把解锁弹窗叫出来。
     * 放在 setTool 里而不是只加在点击事件上 ——
     * 数字快捷键 1-8 走的也是这条路，漏了它等于留了个后门。
     */
    if (def && def.locked && !owns(def.id)) return openUnlock(def);
    tool = id;
    $$('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
    const t = def;
    $('#curTool').textContent = t ? t.name : '';
    document.body.className = document.body.className.replace(/\btool-\w+/g, '').trim();
    if (id !== 'normal') document.body.classList.add('tool-' + id);
    // 只改这一个变量 → 光标立刻换形状，不需要挪动鼠标
    applyToolCursor();
    // 更新角色框上的武器提示（靶子上才需要显示用什么武器打）
    $$('#rosterList .rbox[data-app]').forEach((c) => {
      const hint = c.querySelector('.rb-tool');
      if (hint) hint.textContent = t ? t.ico : '';
      c.classList.toggle('armed', id !== 'normal');
    });
    renderRoster();
  }

  /**
   * 把当前武器的鼠标图形写进 CSS 变量 --tool-cursor。
   * styles.css 里 `.roster { cursor: var(--tool-cursor, default) }` 消费它。
   * 必须给 fallback：图形加载失败时用 crosshair，而不是退化成箭头 + 残影并存。
   */
  function applyToolCursor() {
    let v = HOVER_RESET;
    if (tool !== 'normal') {
      let url = '';
      try {
        url = Jelly.cursor(tool);
      } catch (e) {
        v = 'crosshair';
      }
      if (!v || v !== 'crosshair') v = url ? `url("${url}") 6 6, crosshair` : 'crosshair';
    }
    document.documentElement.style.setProperty('--tool-cursor', v);
  }

  /**
   * 受击时光标抖动（2026-10-12 用户要求：命中点的武器动画停用，
   * 改成光标（武器图形）跟着抖一下作为打击反馈）。
   *
   * CSS cursor 没法做动画，所以用经典的「快速换图」：
   * 生成脚本给每把武器备了两帧抖动变体（图标在画布内偏移 ±3px），
   * 命中时按 偏左上→回位→偏右下→回位 轮换 6 拍（约 270ms），完事恢复正式光标。
   */
  let cursorShakeTimer = null;
  function shakeCursor() {
    const gen = typeof TAMER_CURSORS !== 'undefined' && TAMER_CURSORS[tool];
    if (!gen || !gen.jitter || gen.jitter.length < 2) return;
    if (cursorShakeTimer) return;                    // 抖动进行中不叠加
    const hs = gen.hotspot || [6, 6];
    const seq = [gen.jitter[0], gen.url, gen.jitter[1], gen.url, gen.jitter[0], gen.url];
    let i = 0;
    cursorShakeTimer = setInterval(() => {
      if (i >= seq.length) {
        clearInterval(cursorShakeTimer);
        cursorShakeTimer = null;
        applyToolCursor();                           // 恢复正式光标
        return;
      }
      document.documentElement.style.setProperty(
        '--tool-cursor', `url("${seq[i]}") ${hs[0]} ${hs[1]}, crosshair`
      );
      i++;
    }, 45);
  }

  let hoverTarget = null;

  function trackCursor() {
    // 光标本身由 CSS 变量 + .roster/.wall-wrap 规则接管，这里不再写 cursor。
    // 只保留两件事：角色形象跟随鼠标、武器拖尾特效。
    document.addEventListener('mouseover', (e) => {
      hoverTarget = e.target;
    });

    document.addEventListener('mousemove', (e) => {
      hoverTarget = e.target;

      // 角色框里的角色形象跟着鼠标走 —— 视线与身体都朝指针偏，
      // 这样「瞄准谁」在视觉上一目了然。
      aimAt(e.clientX, e.clientY);

      // 武器拖尾：**只在绿框（角色框区）内产生**，并裁剪到指针所在的那个角色框。
      // 红框（实时画面区）以及侧栏 / 顶栏 / 道具栏 / 状态栏 一律不产生特效，
      // 那些区域只显示系统正常鼠标。
      const clip = rosterClipAt(e.clientX, e.clientY);
      if (!clip) return;
      if (tool === 'normal') {
        fx.trail(e.clientX, e.clientY, 'touch', clip);
        return;
      }
      fx.trail(e.clientX, e.clientY, resampleKind(tool), clip);
      // 按下时向目标甩一下
      if (e.buttons === 1 && fx) fx.whoosh(e.clientX, e.clientY, resampleKind(tool), clip);
    });

    document.addEventListener('mouseleave', () => {
      hoverTarget = null;
    });
  }

  /**
   * 让指针所在角色框里的形象跟着鼠标偏转。
   *
   * 做法：算指针相对框中心的偏移，归一化成 [-1,1] 写进 CSS 变量，
   * 由 SVG 的 transform 消费。只改两个自定义属性，不逐帧改布局，
   * 所以不会引起重排，性能上可以挂在 mousemove 上。
   */
  let lastAimId = null;
  function aimAt(x, y) {
    const id = rosterAt(x, y);
    if (id !== lastAimId) {
      if (lastAimId) {
        const prev = document.querySelector(`.rbox[data-app="${lastAimId}"]`);
        if (prev) prev.style.removeProperty('--aim-x');
        if (prev) prev.style.removeProperty('--aim-y');
      }
      lastAimId = id;
    }
    if (!id) return;
    const el = document.querySelector(`.rbox[data-app="${id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width < 4) return;
    // 归一化到 [-1,1]，中心为 0。留 0.25 边距避免贴边。
    const nx = Math.max(-1, Math.min(1, ((x - r.left) / r.width - 0.5) * 2));
    const ny = Math.max(-1, Math.min(1, ((y - r.top) / r.height - 0.5) * 2));
    el.style.setProperty('--aim-x', nx.toFixed(3));
    el.style.setProperty('--aim-y', ny.toFixed(3));
  }

  /**
   * 取角色框的裁剪矩形（窗口绝对坐标）。
   *
   * 特效层用它把绘制锁在靶子里 —— 鞭痕、迸溅只在被打的那个角色框内出现，
   * 不会溅到预览墙、侧栏、状态栏上。
   */
  function rosterClip(appId) {
    const el = document.querySelector(`.rbox[data-app="${appId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /**
   * 取指针当前所在**角色框**的裁剪矩形。
   * 指针不在任何角色框内时返回 null —— 此时不产生任何拖尾特效，
   * 屏幕上只保留系统正常鼠标。
   */
  function rosterClipAt(x, y) {
    const boxes = $$('.rbox[data-app]');
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        if (r.width < 4 || r.height < 4) return null;
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    return null;
  }

  /**
   * 指针当前所在角色框的 id（不在任何框内返回 null）。
   */
  function rosterAt(x, y) {
    const boxes = $$('.rbox[data-app]');
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return boxes[i].dataset.app;
      }
    }
    return null;
  }

  /** 工具 id → 特效层的 kind */
  function resampleKind(t) {
    return (
      { whip: 'lash', water: 'wet', gun: 'shot', gatling: 'gatling', thunder: 'zap', slipper: 'smack', coffee: 'heal' }[t] || 'lash'
    );
  }

  /**
   * 徒手「摸摸它」：在点击处播手掌动画（纯视觉，不掉血不降压力）。
   * 与抽打共用特效层 —— 徒手也有用户做的视频特效，不打白不打。
   */
  function playTouchFx(appId, ev) {
    const clip = rosterClip(appId);
    if (!clip || !fx) return;
    const x = ev && ev.clientX ? ev.clientX : clip.x + clip.w / 2;
    const y = ev && ev.clientY ? ev.clientY : clip.y + clip.h / 2;
    fx.hit(x, y, 'touch', 0.3, clip, 'normal');
  }

  /* ---------------- 渲染 ---------------- */

  /** 主渲染入口：一次快照 → 全界面 */
  function render(s) {
    if (!s) return;
    applySettings();

    // 顶栏统计已随顶栏删除（2026-10-17）：元素可能不存在，逐个空值保护。
    // 数据本身照常算，将来要把统计放到别处直接接回去就行。
    const setStat = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    setStat('#s-running', s.tasks.filter((t) => t.status === 'running').length);
    setStat('#s-done', s.stats.done);
    setStat('#s-hits', s.stats.hits);
    setStat('#s-crash', s.stats.crashes);

    renderMini(s);
    renderRoster();
    renderWall(s);
    renderTicker(s);
    syncBubbles();
  }

  /* 顶栏「全局进度」已移除，这里不再有聚合进度渲染。 */

/* =================================================================
   预览墙 · 16:9 实时画面 + 本机 AI 应用条
   ================================================================= */

  /** 预览卡尺寸（用户可调） */
  let cardW = 360;
  let fitMode = false;
  let fitCols = 0;          // 列数模式下的实际列数（写进 --fit-cols，用户点 2/3/4 列指定）
  let fitCap = 0;           // 单列时的宽度上限（写进 --fit-cap），0 = 不封顶

  /**
   * 单卡填满模式（用户需求：单击任意一个AI 预览界面 → 它铺满整个显示框）。
   *
   * 与「列数排布」是两件不同的事，必须分开：
   *   fitMode —— 多卡时的等宽等距铺满（列数由用户指定 2/3/4）
   *   solo    —— 只有一张卡时，忽略 --cell-w / --fit-cap，
   *              直接 100% 宽铺满容器，高度交给 16:9 自适应
   *
   * 如果复用 fitMode，单卡会被 fitCap 封在 452*1.4≈633px，
   * 右边留一大片空白 —— 就是用户截图里那个「没铺满」的样子。
   */
  let solo = false;

  const SIZE_KEY = 'vcard.size';

  /**
   * 单卡填满时反算卡片尺寸。
   *
   * ⚠ 关键认知：「填满显示框」和「保持 16:9」在宽扁容器里是**互斥**的。
   *   实测 1440×900：压扁顶部后画面可用区 1187×484。
   *   要 16:9 就只能取 484×(484×16/9)=861px 宽 → 横向填 72%，左右各留 163px。
   *   要横向填满 1187px，高度就会变成 668px，超出 484px 一大截。
   *
   * 用户要的是「填满显示框」，所以单卡模式下**放弃 16:9**：
   *   画面区直接撑满容器宽 × 可用高，由网页自己按容器宽度自适应布局
   *   （Kimi / 豆包 / ChatGPT 都是响应式网页，本来就会跟着容器变）。
   *
   * 多卡模式仍保持严格 16:9 —— 那里需要的是「整齐的一排画面」，
   * 比例一致比铺满更重要。单卡只有一个画面，没有「整齐」可言。
   */
  function updateSoloSize() {
    const wrap = $('#wallScroll');
    const wall = $('#wall');
    if (!wrap || !wall) return;
    const card = wall.querySelector('.vcard');
    if (!card) return;

    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = Math.max(120, wrap.clientWidth - padX);
    // 实测信息条高度，比写死更准（字号/内边距变了也不会算错）
    const infoEl = card.querySelector('.vinfo');
    const infoH = infoEl ? infoEl.getBoundingClientRect().height : 39;
    const availH = Math.max(90, wrap.clientHeight - padY - infoH);

    // 单卡 = 铺满，不再按 16:9 反推（否则宽扁容器下必然左右留白）
    soloW = Math.round(availW);
    soloH = Math.round(availH);

    wall.style.setProperty('--solo-w', soloW + 'px');
    wall.style.setProperty('--solo-h', soloH + 'px');
    scheduleSync();
  }

  let soloW = 0;
  let soloH = 0;

  function applyCardWidth() {
    const wall = $('#wall');
    if (wall) {
      wall.style.setProperty('--cell-w', cardW + 'px');
      if (fitCols) wall.style.setProperty('--fit-cols', String(fitCols));
      if (fitCap) wall.style.setProperty('--fit-cap', fitCap + 'px');
      // 非列数模式时给 1fr 上限，避免卡片被拉成超宽条；
      // 列数模式（2/3/4 列）才允许填满容器。
      wall.classList.toggle('fit', !!fitMode);
      // 单卡填满：CSS 里 .wall.solo 强制 1 列 + 卡片 100% 宽。
      // 用 class 而不是清掉 --cell-w，是为了让用户切回多卡时尺寸还在。
      wall.classList.toggle('solo', !!solo);
    }
    const n = $('#sizeNum');
    if (n) n.textContent = cardW + 'px';
    const r = $('#sizeRange');
    if (r && +r.value !== cardW) r.value = cardW;
    // 卡片尺寸一变，内嵌原生视图必须重新贴合，否则会停在旧位置/旧大小。
    // 这里统一在 applyCardWidth 里触发，所有改尺寸的入口（滑块、列数按钮、
    // 工具条放大、恢复默认）自动都跟着走。
    scheduleSync();
  }

  /*
   * 列数排布（2026-10-24 改版）
   *
   * 旧版叫「等距排列」：列数由 JS 按容器宽度猜（MIN_CARD / MAX_CARD 夹逼），
   * 结果 1440 宽的窗口给 2 列，4K / 5K 宽屏**还是** 2 列 —— 右侧空一大片，
   * 用户直观感受就是「换台电脑分辨率不对」。
   *
   * 现在列数由用户直接指定：右上角「2列 / 3列 / 4列」，点哪个就按哪个
   * 列数把整行等分，卡片等宽等间距、铺满容器。
   *
   * 底层写法和旧版一致 —— 列数写进 --fit-cols，CSS 仍是
   *   repeat(var(--fit-cols), minmax(0,1fr))
   * 用固定列数而不是 auto-fill：auto-fill 的 minmax(cell-w, 1fr) 会按
   * cell-w 估算列数，估少一格右边就空一大块。
   */
  const MIN_CARD = 268;
  const MAX_CARD = 452;
  const GAP = 16;
  const COL_PRESETS = [2, 3, 4];
  const SIZE_MIN = 180;
  const SIZE_ABS_MAX = 1600;   // 绝对上限：再宽的屏也不让单卡糊成一整条

  /**
   * 预览尺寸上限 —— 随容器可用宽度动态放开。
   *
   * ⚠ 原来写死 720：在 4K / 5K 屏上把滑块拖到底，单卡也只占整行的一小截，
   *   两侧留白很难看（用户原话「分辨率高的电脑上预览尺寸只支持到 720」）。
   *   现在上限 = 容器可用宽（一张卡吃掉整行）与 1600 取小，
   *   并且永远不低于 720 —— 小屏行为与旧版完全一致，不会倒退。
   */
  function sizeMax() {
    const wrap = $('#wallScroll');
    if (!wrap) return SIZE_ABS_MAX;
    const cs = getComputedStyle(wrap);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const avail = Math.floor(wrap.clientWidth - padX);
    return Math.max(720, Math.min(SIZE_ABS_MAX, avail || 720));
  }

  function setCols(n) {
    const wrap = $('#wallScroll');
    if (!wrap) return;
    const cs = getComputedStyle(wrap);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const avail = Math.max(120, wrap.clientWidth - padX);
    const cols = Math.max(1, Math.min(COL_PRESETS[COL_PRESETS.length - 1], n | 0));
    const colW = Math.floor((avail - GAP * (cols - 1)) / cols);

    fitCols = cols;
    // 1 列时 1fr 会把卡片拉成「整行宽 × 16:9」的巨物，用 --fit-cap 封顶。
    // 预设只有 2/3/4 列，这一支是外部直接调 setCols(1) 时的兜底。
    fitCap = cols === 1 ? Math.min(avail, Math.round(MAX_CARD * 1.4)) : 0;
    // cardW 只用于滑块回显与非列数模式；列数模式下列宽由 Grid 的 1fr 决定。
    cardW = Math.max(MIN_CARD, Math.min(sizeMax(), colW));
    fitMode = true;
    applyCardWidth();
    paintColButtons();
  }

  /** 列数按钮高亮：只点亮当前生效的那一个 */
  function paintColButtons() {
    COL_PRESETS.forEach((c) => {
      const b = $('#btn-col' + c);
      if (b) b.classList.toggle('on', !!fitMode && c === fitCols);
    });
  }

  /** 退出列数排布，回到滑块控制的固定宽度（不改变当前卡片宽度） */
  function exitFit() {
    fitMode = false;
    fitCols = 0;
    fitCap = 0;
    const wall = $('#wall');
    if (wall) {
      wall.style.removeProperty('--fit-cols');
      wall.style.removeProperty('--fit-cap');
    }
    paintColButtons();
    applyCardWidth();
  }

  function initSizeControl() {
    const r = $('#sizeRange');

    // 滑块上限随容器宽放开：换窗口大小 / 收展侧栏后都要重算
    const syncRangeMax = () => {
      if (!r) return;
      const m = sizeMax();
      if (+r.max !== m) r.max = String(m);
      if (+r.value > m) {
        r.value = String(m);
        cardW = m;
        applyCardWidth();
      }
    };

    if (r) {
      syncRangeMax();
      // 恢复上次选择
      const saved = +localStorage.getItem(SIZE_KEY);
      if (saved >= SIZE_MIN && saved <= sizeMax()) cardW = saved;
      r.value = cardW;
      r.oninput = () => {
        cardW = +r.value;
        // 手动拖滑块 = 放弃列数排布
        if (fitMode) exitFit();
        else applyCardWidth();
        localStorage.setItem(SIZE_KEY, String(cardW));
      };
    }

    // 「2列 / 3列 / 4列」：再点一次当前那个 = 取消列数排布，可反复切换
    COL_PRESETS.forEach((c) => {
      const b = $('#btn-col' + c);
      if (!b) return;
      b.onclick = () => {
        if (fitMode && fitCols === c) exitFit();
        else setCols(c);
        localStorage.setItem(SIZE_KEY, String(cardW));
      };
    });

    const off = $('#btn-fit-off');
    if (off) {
      off.onclick = () => {
        cardW = 360;
        exitFit();
        localStorage.setItem(SIZE_KEY, String(cardW));
      };
    }
    applyCardWidth();
    paintColButtons();
    // 窗口尺寸变化时重算：列数模式下列宽要跟着容器变
    let rt = null;
    window.addEventListener('resize', () => {
      syncRangeMax();
      // 单卡填满模式下同样要重算：容器变宽/变矮时，卡片必须跟着重新贴合，
      // 否则会出现「窗口拉大了但卡片还是原来那么小」或反过来溢出。
      if (solo) {
        clearTimeout(rt);
        rt = setTimeout(updateSoloSize, 120);
        return;
      }
      if (!fitMode) return;
      clearTimeout(rt);
      rt = setTimeout(() => setCols(fitCols), 180);
    });
    /*
     * 侧栏收起/展开**不会触发 window resize**（窗口尺寸没变），但滚动容器的
     * 可用宽变了。solo 模式若不重算，--solo-w 就停在旧值：侧栏展开时卡片
     * 被裁掉右边、收起时靠左留一条空。ResizeObserver 兜住一切
     * 「容器变了但窗口没变」的情况（侧栏开关、今后任何布局改动）。
     * 观察的是滚动容器自身，卡片大小变化不会回流到这里，无死循环风险。
     * 顺带把滑块上限也刷一遍 —— 侧栏一收，预览墙就宽了，上限该跟着放开。
     */
    if (typeof ResizeObserver !== 'undefined') {
      const wallWrap = $('#wallScroll');
      if (wallWrap) {
        let roT = null;
        new ResizeObserver(() => {
          syncRangeMax();
          if (!solo) return;
          clearTimeout(roT);
          roT = setTimeout(updateSoloSize, 100);
        }).observe(wallWrap);
      }
    }
  }

  /*
   * 本机 AI 应用条 —— 2026-10-24 整条下线。
   *
   * App 只内嵌网页版，本机 .app 扫描（local:scan / local:installed）
   * 拿不到任何可用通道：installed 常年是空数组，侧栏那个圆形扫描钮
   * 点了永远没反应。用户要求「连代码一起删」，所以
   *   installed / installedAt / refreshInstalled / legacyOpenConnectPicker
   * 整套移除（后者是只依赖 installed 的旧版接入选择器，早已无人调用，
   * 里面还留着一个根本不存在的 openAppChooser()）。
   * 现在保留的接入入口是 openConnectPicker()（网页版清单）。
   */

  /**
   * 角色框（roster）—— 唯一的抽打靶场 + 接入入口。
   *
   * 布局：
   *   [显示所有] [角色框][角色框]… [+]
   * - 「显示所有」永远排第一，点它下面的展示框就显示全部已接入的 AI。
   * - 每个角色框只对应**已接入**的 AI（session 存在），没接入的不占位。
   * - 一个都没接入时，只留一个虚线的「＋」框。
   * - 点角色框：徒手 = 只看它一个；武器 = 抽打它。
   *
   * ⚠ 关键约束：**绝不能每 tick 全量重建 innerHTML**。
   *   主进程每 320ms 推一次快照，之前每次都重建 DOM，
   *   结果是刚加上的 is-hit 抖动、扣血飘字、冲击环全被下一帧抹掉，
   *   用户只看到「闪一下就没了」。
   *   现在改成：结构签名（有哪些角色 + 选中谁 + 空态）不变时走增量更新，
   *   只改 HP 条宽度 / 进度 / 表情，绝不碰正在播放动画的节点。
   */
  let rosterSig = '';

  function renderRoster() {
    const list = $('#rosterList');
    const meta = $('#rosterMeta');
    if (!list) return;

    const metaEl = meta;
    if (metaEl) {
      metaEl.textContent = '仅支持网页版 · 可添加自定义网址';
    }

    // 已接入的角色按当前网页会话顺序展示。
    const liveIds = Object.keys(sessions).filter((sid) => sessions[sid].status !== 'closed');
    const connectedIds = [];
    // 装在别处但已接入的（观察通道、手动接入）也补进来
    liveIds.forEach((sid) => {
      const id = sessions[sid].appId;
      if (id && !connectedIds.includes(id)) connectedIds.push(id);
    });

    // ---- 结构签名：只有它变了才允许重建 DOM ----
    // skinSig：任何 AI 换了形象都要触发一次重建（增量路径不换皮）。
    const skinSig = S && Array.isArray(S.chars) ? S.chars.map((c) => c.skin || c.id).join(',') : '';
    const sig = connectedIds.join(',') + '|' + skinSig + '|' + (selected || '') + '|' + tool;
    if (sig === rosterSig) {
      updateRosterLive(connectedIds);
      return;
    }
    rosterSig = sig;

    // ---- 空态：一个已接入的都没有，只留虚线「＋」----
    if (!connectedIds.length) {
      list.innerHTML = `<div class="roster-empty">还没有接入任何 AI</div>
        <button class="rbox rbox-add" id="rosterAdd" title="接入一个 AI 应用">
          <span class="rb-ico rb-plus">＋</span>
          <span class="rb-name">接入 AI 应用</span>
        </button>`;
      const add = $('#rosterAdd');
      if (add) add.onclick = () => openConnectPicker();
      return;
    }

    const boxes = connectedIds
      .map((id) => {
        const def = byId(id);
        if (!def) return '';
        const m = rosterMetrics(id);
        return `<button class="rbox ${selected === id ? 'sel' : ''}" data-app="${id}"
            style="--tone:${m.tone};--hp-c:${hpColor(id)}" title="${escapeAttr(nameOf(id) + ' · ' + m.chLabel + ' · 点它抽打 · 右键看属性')}">
          <span class="rb-tool">${toolIco()}</span>
          <span class="rb-flash"></span>
          <span class="rb-dmg" data-dmg></span>
          <span class="rb-combo" data-combo></span>
          <span class="rb-logo">${logoHtml(id)}</span>
          <span class="rb-fig">${Jelly.render(skinOf(id), { size: 84, state: m.state, key: 'rb-' + id, hp: m.hp })}</span>
          <span class="rb-meta">
            <span class="rb-name">${escapeHtml(nameOf(id))}</span>
            <span class="rb-sub">${escapeHtml(m.chLabel)} · ${m.pct}%</span>
          </span>
          <span class="rb-band">
            <span class="rb-bars">
              <i class="rb-task" data-task style="width:${m.pct}%"></i>
              <i class="rb-hpghost" data-ghost style="width:${m.hp}%"></i>
              <i class="rb-hp ${hpCls(m.hp, m.state)}" data-hp style="width:${m.hp}%"></i>
            </span>
            <span class="rb-hpnum ${hpCls(m.hp, m.state)}" data-hpnum>${m.hp}</span>
          </span>
        </button>`;
      })
      .join('');

    list.innerHTML =
      `<button class="rbox rbox-all ${selected ? '' : 'on'}" id="rosterAll" title="显示所有已接入的 AI">
         <span class="rb-ico">▦</span>
         <span class="rb-name">显示所有</span>
         <span class="rb-sub">${connectedIds.length} 个已接入</span>
       </button>` +
      boxes +
      `<button class="rbox rbox-add" id="rosterAdd" title="再接入一个 AI 应用">
         <span class="rb-ico rb-plus">＋</span>
       </button>`;

    // 「显示所有」：取消选中 → 展示框回到全部
    const all = $('#rosterAll');
    if (all) all.onclick = () => {
      selected = null;
      render(S);
      SFX.play('ding');
    };
    const add = $('#rosterAdd');
    if (add) add.onclick = () => openConnectPicker();

    // 点角色框：徒手 = 单看它（并铺满显示框）；武器 = 抽打它
    $$('#rosterList .rbox[data-app]').forEach((el) => {
      const id = el.dataset.app;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tool === 'normal') {
          playTouchFx(id, e);
          selected = selected === id ? null : id;
          render(S);
          return;
        }
        doHit(id, e);
      });
      /*
       * 右键角色框 = 属性（改名 + 换形象）。
       * 曾经是「双击改名」，但抽打是高频连点操作，双击极易误触，
       * 弹窗会打断连击节奏 —— 改为右键后，左键连点再快也不会碰到它。
       */
      el.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openCharProps(id);
      });
    });
  }

  /**
   * 某个角色血条的主题色：跟随它当前的形象（skin）走，
   * 换皮后血条颜色跟着新形象变 —— 每个角色一眼能认出自己的血条。
   * 取 palette.b（角色主色），异常时回落 CSS 里的默认 --ok。
   */
  function hpColor(id) {
    const def = skinOf(id);
    const c = def && def.palette && def.palette.b;
    return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '';
  }

  /**
   * 血条档位 → 造型（2026-10-12 用户定的规则，替代「按情绪状态换造型」）：
   *
   *     100 ─ 81  开心 joy      满血，最精神
   *      80 ─ 61  待命 idle
   *      60 ─ 41  搬砖 working
   *      40 ─  1  求饶 beg      40 和 20 都是求饶
   *       0       阵亡 down
   *
   * 「被打 hit」不在这张表里 —— 它是挨打瞬间叠上去的一层动画，
   * 打完之后造型仍按当前血量档位显示。
   * 造型只认血量，情绪状态（搬砖/求饶）由引擎负责逻辑，界面不再各说各话。
   */
  function hpArt(pct) {
    const n = Math.max(0, Math.min(100, Number(pct) || 0));
    if (n <= 0) return 'down';
    if (n > 80) return 'joy';
    if (n > 60) return 'idle';
    if (n > 40) return 'working';
    return 'beg';
  }

  /**
   * 血量百分比拆成两个值（武器伤害 ÷10 之后，单次掉血小于 1%，取整会失真）：
   *   exact —— 带小数，用来判造型档位（只剩 0.4 血 ≠ 阵亡）
   *   shown —— 取整，用来显示数字 / 条宽；只要还有血就至少 1%，
   *            避免出现「0% 却还在求饶」这种自相矛盾的画面
   */
  function hpPctOf(hpAbs, maxHp) {
    const m = Number(maxHp) > 0 ? Number(maxHp) : 100;
    const exact = Math.max(0, Math.min(100, ((Number(hpAbs) || 0) / m) * 100));
    return { exact, shown: exact > 0 ? Math.max(1, Math.round(exact)) : 0 };
  }

  /**
   * 血条的状态造型类（2026-10-12 用户要求「血条按状态变造型」）：
   *   down(阵亡) → 变灰 + 斜纹，一眼看出「这条命没了」，优先级最高；
   *   low(低于 35%) → 变红警示；
   *   其余 → 用角色自己的形象主色（--hp-c）。
   * 只负责返回类名，具体长什么样全在 CSS 里，三处血条共用同一套规则。
   */
  function hpCls(hp, state) {
    if (state === 'down') return 'down';
    return hp < 35 ? 'low' : '';
  }

  function toolIco() {
    const t = TOOLS_DEF.find((x) => x.id === tool);
    return t ? t.ico : '';
  }

  /* ---- 角色卡左上角的 AI logo ----
   * 有本地 logo 文件（assets/logos/<id>.png）就显示它；
   * 没有就回落到「应用名首字母」徽章。img 挂掉时靠全局 error 捕获移除，
   * 字母徽章垫在底下 —— 不需要每个卡片单独绑 onerror。 */
  let logoErrBound = false;
  function bindLogoFallback() {
    if (logoErrBound || typeof document === 'undefined') return;
    logoErrBound = true;
    document.addEventListener('error', (e) => {
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.hasAttribute('data-logo-img')) t.remove();
    }, true);
  }

  function logoHtml(id) {
    const def = byId(id);
    const label = (def && (def.app || def.name)) || id;
    const letter = escapeHtml(String(label).trim().charAt(0).toUpperCase());
    return `<img src="${ASSET_BASE}assets/logos/${escapeAttr(id)}.png" alt="" data-logo-img><b>${letter}</b>`;
  }

  /** 某个角色在角色框上要显示的全部派生数据 */
  function rosterMetrics(id) {
    // 画皮用「用户选的形象」，逻辑数据（血量/状态）仍是这个 AI 自己的
    const def = skinOf(id);
    const c = S ? S.chars.find((x) => x.id === id) : null;
    const sid = sessionOf(id);
    const s = sid ? sessions[sid] : null;
    const watchPct = s && s.channel === 'watch' && typeof s.progress === 'number' ? s.progress : null;
    const top = c && (c.activeTasks || [])[0];
    const pct = watchPct != null ? watchPct : top ? Math.round(top.progress) : 0;
    const maxHp = (c && c.maxHp) || 100;
    const hpPct = c ? hpPctOf(c.hp, maxHp) : { exact: 100, shown: 100 };
    const hp = hpPct.shown;
    const chKind = s ? s.channel : '';
    const chLabel =
      chKind === 'embed' ? '网页'
      : chKind === 'cli' ? '命令行'
      : chKind === 'watch' ? '观察'
      : chKind === 'app' ? '应用'
      : chKind === 'url' ? '网页'
      : '在线';
    // 造型 = 血条档位（hpArt），不再是引擎的情绪状态 —— 见 hpArt 注释
    const art = hpArt(hpPct.exact);
    return {
      def,
      state: art,
      tone: TONE[art] || 'transparent',
      pct: Math.round(pct),
      hp,
      chLabel,
      title: escapeAttr(nameOf(id) + ' · ' + (s && s.name ? s.name : chLabel))
    };
  }

  /**
   * 增量更新：只改数值和表情，绝不重建节点。
   * 这样正在播放的抖动 / 扣血飘字 / 冲击环不会被下一帧（320ms 后）抹掉。
   */
  function updateRosterLive(connectedIds) {
    connectedIds.forEach((id) => {
      const el = document.querySelector(`#rosterList .rbox[data-app="${id}"]`);
      if (!el) return;
      const m = rosterMetrics(id);

      el.style.setProperty('--tone', m.tone);
      const t = el.getAttribute('title');
      if (t !== m.title) el.setAttribute('title', m.title);

      const sub = el.querySelector('.rb-sub');
      if (sub) {
        const txt = m.chLabel + ' · ' + m.pct + '%';
        if (sub.textContent !== txt) sub.textContent = txt;
      }

      const task = el.querySelector('[data-task]');
      if (task) task.style.width = m.pct + '%';

      const hpEl = el.querySelector('[data-hp]');
      if (hpEl) {
        hpEl.style.width = m.hp + '%';
        // 阵亡(灰斜纹) 优先于 低血(红)：0 血同时也是「低血」，得让 down 赢
        hpEl.classList.toggle('down', m.state === 'down');
        hpEl.classList.toggle('low', m.state !== 'down' && m.hp < 35);
      }
      const ghost = el.querySelector('[data-ghost]');
      if (ghost) {
        // 残影槽紧跟真实血量：真实血掉下去后，ghost 用 transition 慢一拍回落，
        // 视觉上就是「被削掉一截」
        ghost.style.width = m.hp + '%';
      }
      const num = el.querySelector('[data-hpnum]');
      if (num) {
        num.textContent = m.hp;
        num.classList.toggle('down', m.state === 'down');
        num.classList.toggle('low', m.state !== 'down' && m.hp < 35);
      }

      // 表情变了才重画 SVG，并且重画后把 --aim-x/y 重新贴回去，
      // 免得正在跟随鼠标的形象突然「僵住」一瞬。
      // SVG 换了节点后旧的 .hit 动画节点会脱离文档，这里只认当前 fig 里的 svg。
      const fig = el.querySelector('.rb-fig');
      if (fig) {
        const cur = fig.dataset.state || '';
        if (cur !== m.state && m.def) {
          const aimX = el.style.getPropertyValue('--aim-x');
          const aimY = el.style.getPropertyValue('--aim-y');
          fig.dataset.state = m.state;
          fig.innerHTML = Jelly.render(m.def, { size: 84, state: m.state, key: 'rb-' + id, hp: m.hp });
          if (aimX) fig.style.setProperty('--aim-x', aimX);
          if (aimY) fig.style.setProperty('--aim-y', aimY);
        }
      }
    });
  }

  /**
   * 本机应用选择器：搜索 + 全量清单 + 一点就加。
   *
   * 用户需求原文：「能不能增加一个 用户自己主动去连接本地app的功能，
   * 这样就不局限于只是 ai 相关的工具了」
   *
   * 之前接入面板只有 AI_HINT 过滤后的 5 个应用可选。这里换成全量
   * 本机 .app（实测 102 个），微信 / Notion / 终端 / 任何软件都能加。
   */
  async function legacyOpenAppChooser() {
    const wrap = modal(`
      <h3>添加本地应用</h3>
      <p class="desc">本机装了什么就能加什么，不限 AI。加进来之后它就是一个角色：能被抽打、能看实时画面、能收文字。</p>
      <input class="pick-search" id="acSearch" placeholder="搜索应用名…" autocomplete="off" spellcheck="false" />
      <div class="pick-list" id="acList"><div class="pick-empty">正在读取本机应用…</div></div>
      <div class="modal-foot">
        <button class="btn" id="acClose">返回</button>
      </div>
    `);

    const list = wrap.querySelector('#acList');
    const search = wrap.querySelector('#acSearch');
    let all = [];

    const paint = (items) => {
      if (!items.length) {
        list.innerHTML =
          '<div class="pick-empty">没匹配到应用<br><span style="font-size:11px">换个词试试，或确认它装在 /Applications 下</span></div>';
        return;
      }
      list.innerHTML = items
        .map(
          (a) => `
          <div class="pick-row" data-add="${escapeAttr(a.appPath)}">
            <span class="dot ${a.added ? 'live' : ''}"></span>
            <div class="pick-info">
              <div class="pick-name">${escapeHtml(a.name)}</div>
              <div class="pick-sub">${a.version ? 'v' + escapeHtml(a.version) : '已安装'}${
                a.electron ? ' · Electron' : ''
              }</div>
            </div>
            <div class="pick-acts">
              ${
                a.added && a.id
                  ? `<button class="btn primary" data-join="${escapeAttr(a.id)}">接入</button>`
                  : a.added
                  ? '<span class="pick-sub">已添加</span>'
                  : `<button class="btn primary" data-addbtn="${escapeAttr(a.appPath)}">添加</button>`
              }
            </div>
          </div>`
        )
        .join('');
    };

    // 搜索：本地过滤，避免每敲一个字就打一次 IPC
    const doFilter = () => {
      const kw = search.value.trim().toLowerCase();
      if (!kw) return paint(all.slice(0, 60)); // 首次只铺 60 个，避免上百行卡顿
      paint(
        all.filter(
          (a) =>
            a.name.toLowerCase().includes(kw) ||
            String(a.appPath).toLowerCase().includes(kw)
        )
      );
    };

    const doAdd = async (appPath) => {
      const meta = all.find((a) => a.appPath === appPath);
      if (!meta) return;
      const r = await window.api.addCustomApp({
        appPath: meta.appPath,
        bundleId: meta.bundleId,
        name: meta.name,
        version: meta.version
      });
      if (!r || !r.ok) {
        toast('添加失败：' + ((r && r.msg) || '未知原因'));
        return;
      }
      /*
       * 刻意**不**在这里自动连接。
       *
       * 原来是「点添加 → 直接连接」，用户反馈「反复弹出辅助功能权限」——
       * 连锁是这么来的：每点一个应用就触发一轮连接 + 权限检查，
       * 连点五个就是五次弹窗，人还没来得及去系统设置里开就被淹了。
       *
       * 改成加完就停，让用户自己点「接入」。一次一个，弹窗也只可能一次，
       * 而且他能清楚知道是在给哪个应用授权。
       */
      meta.added = true;
      doFilter();
      toast((r.already ? '已经在场：' : '已添加：') + (meta.name || '') + ' —— 点「接入」开始连接');
    };

    /** 接入一个已添加的自定义应用 */
    const doJoin = async (id) => {
      await doConnect(id, 'app');
      wrap.remove();
      openConnectPicker();
    };

    list.addEventListener('click', (e) => {
      const join = e.target.closest('[data-join]');
      if (join) {
        e.stopPropagation();
        doJoin(join.dataset.join);
        return;
      }
      const b = e.target.closest('[data-addbtn]');
      if (b) {
        e.stopPropagation();
        doAdd(b.dataset.addbtn);
        return;
      }
      // 点整行也能加，减少一次精确点击
      const row = e.target.closest('[data-add]');
      if (row && !e.target.closest('.pick-acts')) doAdd(row.dataset.add);
    });

    search.addEventListener('input', doFilter);
    wrap.querySelector('#acClose').onclick = () => {
      wrap.remove();
      openConnectPicker();
    };

    const r = await window.api.listAllApps('');
    all = (r && r.apps) || [];
    // 已添加的排前面：用户回头找自己加过的应用时一眼能看见
    all.sort((a, b) => (a.added === b.added ? 0 : a.added ? -1 : 1));
    paint(all.slice(0, 60));

    setTimeout(() => search.focus(), 30);
  }

  /**
   * 「＋ 新建标签页」的输入弹窗。
   *
   * ⚠ 为什么不能用 window.prompt：
   *   Electron 把 window.prompt 覆盖成「抛异常」的函数
   *   （lib/renderer/window-setup.ts，无条件赋值），
   *   调用它会直接 throw，于是「＋」按钮表现为**点了毫无反应**。
   *   历史版本就是这么写的，功能等于不存在 —— 直到有人真的点一次才发现。
   *
   * 这里走应用自己的 modal，校验规则与「接入网页版 → 添加自定义网址」完全一致，
   * 避免两处对同一个东西给出不同的合法性判断。
   *
   * @param {object} s 当前卡片对应的会话记录（含 sid / embedKey / embedTabs）
   */
  function openTabUrlDialog(s) {
    if (!s || !s.sid) return toast('这个监视器还没接入网页，无法新建标签');

    const wrap = modal(`
      <h3>新建标签页</h3>
      <p class="desc">在这个监视器里再开一个网页。原标签不会被关掉，切回去内容还在。</p>
      <input class="pick-search" id="tabUrl" placeholder="https://example.com" autocomplete="off" spellcheck="false" />
      <div class="modal-foot">
        <button class="btn" id="tabCancel">取消</button>
        <button class="btn primary" id="tabOk">打开</button>
      </div>`);

    const input = wrap.querySelector('#tabUrl');
    setTimeout(() => { if (input) input.focus(); }, 60);

    const submit = async () => {
      const raw = (input.value || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(raw)) return toast('请输入有效的 HTTP/HTTPS 网址');
      // 标题只用来占位，取不到 hostname 也不影响打开
      let host = raw;
      try { host = new URL(raw).hostname; } catch (e) {}
      const r = await window.api.embedOpenTab(s.sid, { url: raw, title: host, login: true });
      if (!r || !r.ok) return toast((r && r.msg) || '新标签打开失败');
      s.embedKey = r.embedKey;
      s.embedTabs = r.embedTabs;
      wrap.remove();
      renderWall(S);
    };

    wrap.querySelector('#tabOk').onclick = submit;
    wrap.querySelector('#tabCancel').onclick = () => wrap.remove();
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); wrap.remove(); }
      });
    }
    return wrap;
  }

  /** 网页版接入选择器：内置 AI 网站 + 客户自定义网址。 */
  async function openConnectPicker() {
    // 扫描结果还没就绪（比如启动时扫描失败）就先补扫一次，
    // 不然内置列表会空空如也，用户还以为内置 AI 被删了
    if (!scan) await doScan(true);
    const builtins = (S && S.chars ? S.chars : []).filter((c) => scan && scan.results && scan.results[c.id] && scan.results[c.id].length);
    let custom = [];
    try { custom = await window.api.listCustomWebs(); } catch (e) {}
    const row = (id, name, ch, isCustom) => {
      const sid = sessionOf(id);
      return `<div class="pick-row ${sid ? 'on' : ''}">
        <span class="dot ${sid ? 'live' : ''}"></span>
        <div class="pick-info"><div class="pick-name">${escapeHtml(name)}</div>
          <div class="pick-sub">网页版${ch && ch.url ? ' · ' + escapeHtml(ch.url) : ''}</div></div>
        <div class="pick-acts"><button class="btn" data-skin="${escapeAttr(id)}" title="从角色库给它换一套形象">形象</button><button class="btn ${sid ? 'primary' : ''}" data-web-connect="${escapeAttr(id)}">${sid ? '断开' : '接入'}</button>${isCustom ? `<button class="btn danger" data-web-del="${escapeAttr(id)}" title="删除这个自定义网址">删除</button>` : ''}</div>
      </div>`;
    };
    const rows = builtins.map((c) => row(c.id, nameOfChar(c), (scan.best || {})[c.id])).join('');
    const customRows = custom.map((w) => row(w.id, w.name, w, true)).join('');
    const wrap = modal(`<h3>接入网页版</h3>
      <p class="desc">内置 AI 网站会直接嵌在当前窗口中，不调用本机 App，也不需要系统权限。</p>
      <div class="pick-list">${rows || '<div class="pick-empty">暂无内置网页版</div>'}${customRows ? '<div class="pick-section">自定义网址</div>' + customRows : ''}</div>
      <div class="custom-web-form">
        <input class="pick-search" id="webName" placeholder="名称（可选）" autocomplete="off" />
        <input class="pick-search" id="webUrl" placeholder="https://example.com" autocomplete="off" spellcheck="false" />
        <button class="btn primary" id="webAdd">添加并接入</button>
      </div>
      <div class="modal-foot"><button class="btn" id="pkScan">重新加载网页版列表</button><button class="btn primary" id="pkClose">完成</button></div>`);
    wrap.querySelectorAll('[data-web-connect]').forEach((b) => {
      b.onclick = async () => { await doConnect(b.dataset.webConnect, 'embed'); wrap.remove(); };
    });
    wrap.querySelectorAll('[data-skin]').forEach((b) => {
      b.onclick = () => { wrap.remove(); openSkinPicker(b.dataset.skin); };
    });
    // 删除自定义网址：主进程会先断开它的会话再删存档，这里只负责刷新界面与列表
    wrap.querySelectorAll('[data-web-del]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.webDel;
        const name = custom.find((w) => w.id === id);
        if (!confirm(`确定删除「${(name && name.name) || '这个网址'}」吗？\n如果它正在接入，会一并断开。`)) return;
        const r = await window.api.removeCustomWeb(id);
        if (!r || !r.ok) return toast((r && r.msg) || '删除失败');
        // 渲染层这边的会话映射也要清掉（主进程已断开）
        Object.keys(sessions).forEach((sid) => {
          if (sessions[sid].appId === id) delete sessions[sid];
        });
        connected.delete(id);
        if (activeSid && !sessions[activeSid]) activeSid = null;
        if (watchSid && !sessions[watchSid]) watchSid = null;
        if (S) render(S);
        toast('已删除');
        wrap.remove();
        openConnectPicker();
      };
    });
    wrap.querySelector('#webAdd').onclick = async () => {
      const url = wrap.querySelector('#webUrl').value.trim();
      const name = wrap.querySelector('#webName').value.trim();
      const r = await window.api.addCustomWeb({ url, name });
      if (!r || !r.ok) return toast((r && r.msg) || '网址无效');
      await doConnect(r.id, 'embed');
      wrap.remove();
    };
    wrap.querySelector('#pkScan').onclick = async () => { await doScan(true); wrap.remove(); openConnectPicker(); };
    wrap.querySelector('#pkClose').onclick = () => wrap.remove();
  }

  /**
   * 角色库：给某个 AI 挑形象。
   * 12 个内置角色全部用「开心」形象展示（用户拍板的主 IP 形象），
   * 点谁谁上岗，当前形象高亮；「默认」格子= 恢复这个 AI 自己原本的形象。
   * 只换画皮 —— 台词、脾气、血量、亲和度全部还是这个 AI 自己的。
   */
  function openSkinPicker(appId) {
    const cur = skinOf(appId);
    const curId = cur ? cur.id : appId;
    const cells = CHARACTERS.map((def) => {
      const on = def.id === curId;
      const isDefault = def.id === appId;
      return `<button class="skin-cell ${on ? 'on' : ''}" data-skin-pick="${escapeAttr(def.id)}"
          title="${escapeAttr((def.app || def.id) + (isDefault ? ' · 默认形象' : ''))}">
        <span class="skin-fig">${Jelly.render(def, { size: 74, state: 'joy', key: 'sk-' + def.id })}</span>
        <span class="skin-name">${escapeHtml(def.app || def.id)}${isDefault ? ' · 默认' : ''}</span>
      </button>`;
    }).join('');
    const wrap = modal(`<h3>角色形象 · ${escapeHtml(nameOf(appId))}</h3>
      <p class="desc">从角色库里挑一个形象给它用，只换皮不改台词和脾气。选「默认」恢复原本形象。</p>
      <div class="skin-grid">${cells}</div>
      <div class="modal-foot"><button class="btn primary" id="skinClose">完成</button></div>`);
    wrap.querySelectorAll('[data-skin-pick]').forEach((b) => {
      b.onclick = async () => {
        const r = await window.api.setSkin(appId, b.dataset.skinPick);
        if (!r || !r.ok) return toast((r && r.msg) || '换形象失败');
        wrap.remove();
        toast('形象已更新');
      };
    });
    wrap.querySelector('#skinClose').onclick = () => wrap.remove();
  }

  /* ---------------- 预览墙 ---------------- */

  /** 重绘前记录「谁在输入、输了什么」，重绘后原样恢复 */
  let focusMemo = null;

  function captureFocus() {
    const a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains('vin')) {
      focusMemo = null;
      return;
    }
    const card = a.closest('.vcard');
    if (!card) {
      focusMemo = null;
      return;
    }
    const lines = a.closest('.vscene') && a.closest('.vscene').querySelector('.vlines');
    focusMemo = { appId: card.dataset.app, sid: lines ? lines.dataset.sid : '', value: a.value };
  }

  /*
   * 2026-10-17 二稿：角色板**永久常驻**左侧栏（index.html 里已搬家），
   * 不再按 solo 模式搬来搬去 —— 顶栏整条删除，多卡/单看布局统一：
   * 侧栏从上到下 = 「显示所有」/「＋」/角色卡（竖排、可滚动）。
   * 此前的 layoutSoloChrome 搬家逻辑随之删除。
   */

  function renderWall(s) {
    captureFocus();
    const wall = $('#wall');
    const wrap = $('#wallScroll');

    // 只展示**已接入**的 AI。
    // 理由：这页是「它现在到底在干什么」的大画面，
    // 没接入就没有真实内容可看，摆一张空卡只是噪声。
    const live = new Set(
      Object.keys(sessions).filter((sid) => sessions[sid].status !== 'closed').map((sid) => sessions[sid].appId)
    );

    // 只按「选中谁」过滤（「显示所有」= 不选）。
    // 原来的 view 状态筛选（进行中/排队中/已完成/报废）已随侧栏一起删除。
    const list0 = selected ? s.chars.filter((c) => c.id === selected) : s.chars.slice();
    const list = list0.filter((c) => live.has(c.id));
    // 用户拖动过的顺序优先（长按标签条空白处拖动改序，落 localStorage 持久化）
    list.sort((a, b) => wallOrderRank(a.id) - wallOrderRank(b.id));

    /*
     * 单卡填满模式跟随「选中谁」自动切换：
     *   选中单个 → solo = true，卡片 100% 宽铺满显示框
     *   显示所有 → solo = false，回到等距/固定宽度
     * 这样点顶部角色框、点左侧名册、点预览卡三条路径都会得到一致的铺满效果，
     * 不需要每个入口各自记一份状态。
     */
    const wantSolo = !!selected && list.length === 1;
    if (wantSolo !== solo) {
      solo = wantSolo;
      soloW = 0;                // 切模式时强制重算
      // body.solo 让道具栏/标题行一起压扁，把垂直空间让给画面。
      // 这必须与 .wall.solo 同步切，否则会出现「卡片按压扁后的高度算，
      // 但容器还是压扁前的尺寸」→ 首帧尺寸错位。
      // （角色板已常驻侧栏，不再参与 solo 切换 —— 2026-10-17 二稿）
      document.body.classList.toggle('solo', solo);
      applyCardWidth();
    }

    $('#wallTitle').textContent = selected ? nameOf(selected) + ' · 实时画面' : 'AI 工作界面';
    $('#wallSub').textContent = selected
      ? byId(selected).tag + ' · 16:9 实时画面'
      : '已接入的 AI 都在这里 16:9 实时画面里干活 · 抽打请点左侧角色卡';

    // 一个都没接入：整页不出现任何角色卡，只留一个虚线「＋」
    if (!live.size) {
      wall.innerHTML = `<div class="wall-blank">
        <button class="wb-add" id="wbAdd" title="接入一个 AI 应用">
          <span class="wb-plus">＋</span>
          <span class="wb-t">接入 AI 应用</span>
        </button>
        <div class="wb-d">还没接入任何 AI，所以这里没有画面。<br>接入后，每个 AI 会在这里占一块 16:9 实时画面。</div>
      </div>`;
      const wb = $('#wbAdd');
      if (wb) wb.onclick = () => openConnectPicker();
      // 内嵌视图必须全部收走，否则会残留浮层挡住这个空态。
      // syncEmbedBounds() 会把存活名单（此时为空）上报给主进程，
      // 由 retainOnly 把所有视图收成 0×0 —— 比逐个遍历 sessions 更彻底，
      // 因为 sessions 里可能已经没有对应记录，但视图还在。
      syncEmbedBounds();
      return;
    }

    if (!list.length) {
      wall.innerHTML = `<div class="wall-empty">这个角色还没接入<br><span style="font-size:11px">点左侧「显示所有」回去，或在角色板点「＋」接入</span></div>`;
      // 同上：名单为空 = 全部收走
      syncEmbedBounds();
      return;
    }

    wall.innerHTML = list.map((c) => vcardHtml(c)).join('');

    // 卡片数量变了，列数模式下列宽也要跟着重算（比如刚接入了一个 AI）
    if (fitMode) setCols(fitCols);

    /*
     * 单卡填满：必须在卡片**已经进 DOM 之后**才能算尺寸。
     * updateSoloSize 要量.vinfo 的真实高度，DOM 还不存在时量不到，
     * 算出来的会把信息条高度漏掉，卡片就会超出容器一截。
     */
    if (solo) {
      updateSoloSize();
      /*
       * 再补一帧：body.solo 的压扁样式是这一帧才生效的，
       * 而 updateSoloSize 量的是**压扁之后**的容器高度。
       * 同一帧里读到的可能还是旧高度，所以下一帧再算一次，
       * 否则首帧会按压扁前的尺寸定宽，画面小一圈。
       */
      requestAnimationFrame(() => {
        if (solo) updateSoloSize();
      });
    }

    /*
     * 立刻同步一次，再补一次延迟的。
     *
     * 为什么不只靠 scheduleSync：
     *   从「显示所有」切到「只看豆包」时，Kimi 的 .embed-hole 刚刚从 DOM 里消失。
     *   scheduleSync 有 60ms 延迟，这段时间里 Kimi 的 WebContentsView
     *   仍然按旧bounds 浮在窗口上 —— 用户会看到一瞬间的画面残留/错位。
     *   先立刻收一次（retainOnly 会把名单外的视图收成 0×0），
     *   再由延迟的那次补齐新卡片的精确位置。
     */
    syncEmbedBounds();
    scheduleSync();
    /*
     * 切模式（solo ↔ 多卡）的过渡帧里，洞的矩形可能量到中间态
     * （.solo 类刚挂/刚摘、--solo-w 还是旧值、body.solo 的压扁样式
     * 刚生效）。上面两次同步如果恰好用的是中间态，原生视图就会停在
     * 错误的尺寸上 —— 表现为「从单独页面切出来后右侧部分不可见」。
     * 这里补几拍延迟重拍，任何一拍量到最终布局都会覆盖前面的错值。
     * 加长的两拍（700 / 1200ms）专治 solo 大卡：卡宽从 400 直接跳到
     * 1200+ 时，网页要做一次响应式重排，第一拍量到的可能还是旧视口。
     */
    [150, 350, 700, 1200].forEach((ms) => setTimeout(syncEmbedBounds, ms));

    // 逐卡绑定
    $$('#wall .vcard').forEach((el) => {
      const id = el.dataset.app;

      // 连接按钮
      const lb = el.querySelector('.vlink-btn');
      if (lb) {
        lb.onclick = (e) => {
          e.stopPropagation();
          doConnect(id);
        };
      }

      // 属性按钮（✎）：打开「改名 + 换形象」合一的属性弹窗。
      // 必须 stopPropagation，否则会连带触发卡片的「填满显示框」。
      const rn = el.querySelector('.vrename-btn');
      if (rn) {
        rn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          openCharProps(id);
        };
      }

      // 内嵌视图工具条：后退 / 刷新 / 放大 / 外部打开 / 关闭
      const tools = el.querySelector('.embed-tools');
      const tabs = el.querySelector('.embed-tabs');
      if (tabs) {
        tabs.addEventListener('click', async (e) => {
          const close = e.target.closest('[data-tab-close]');
          const tab = e.target.closest('[data-tab-key]');
          const s = sessions[sessionOf(id)];
          // 标签按钮 / 关闭「×」/ 新建「＋」：各自的语义，吃掉事件，
          // 不许冒泡到卡片本体（否则点个关闭还会连带切换全视窗）。
          if (close || tab || e.target.closest('[data-tab-add]')) {
            if (!s) return;
            e.stopPropagation();
            if (close) {
              const r = await window.api.embedCloseTab(s.sid, close.dataset.tabClose);
              if (!r || !r.ok) return toast((r && r.msg) || '标签关闭失败');
              s.embedKey = r.embedKey; s.embedTabs = r.embedTabs; renderWall(S); return;
            }
            if (tab) {
              const r = await window.api.embedActivateTab(s.sid, tab.dataset.tabKey);
              if (r && r.ok) { s.embedKey = r.embedKey; s.embedTabs = r.embedTabs; renderWall(S); }
              return;
            }
            /*
             * ⚠⚠ 绝对不能用 window.prompt —— Electron 里它是个「点了没反应」的死按钮。
             *
             * Electron 在每个渲染进程里把 window.prompt 覆盖成一个**直接抛异常**的
             * 函数。出处在 Electron 自己的源码 lib/renderer/window-setup.ts：
             *
             *   window.prompt = function () {
             *     throw new Error('prompt() is and will not be supported.')
             *   }
             *
             * 这句赋值写在 if 条件的逗号表达式里，是**无条件**执行的，
             * 且 file:// 页面走 renderer-init 的 default 分支 → 必被调用。
             *
             * 后果：点「＋」→ 回调静默抛异常 → 按钮看起来完全没反应，
             * 也没有任何错误提示（除非去翻 DevTools 的 unhandled rejection）。
             * 所以这里改用应用自己的弹窗，校验规则与「接入网页版」里保持一致。
             */
            openTabUrlDialog(s);
            return;
          }
          /*
           * 空白处单击 = 进/出全视窗（用户需求：交互合并 —— 只要不是点到
           * 标签页，单击就切换全视窗；长按拖动由 bindWallDrag 负责，
           * 拖完松手冒上来的 click 已被 justDragged 吞掉，不会误切）。
           *
           * ⚠ 必须 stopPropagation。
           *
           * 标签条长在卡片内部，click 会继续冒泡到 el.onclick（卡片本体的
           * 「单击填满」）。两个处理器各切一次 selected → 一进一出，
           * 净变化为 0 —— 用户看到的就是「点标签栏完全没反应」。
           * 这里吃掉事件，全视窗切换只由本处理器做一次。
           */
          if (justDragged) return;
          e.stopPropagation();
          selected = selected === id ? null : id;
          render(S);
          renderRoster();
        });
      }
      if (tools) {
        tools.addEventListener('click', (e) => {
          const b = e.target.closest('.et-btn');
          if (!b) return;
          // 内嵌视图是一层浮在页面上的原生视图，
          // 不拦住的话点它等于点在底下那个「洞」上
          e.stopPropagation();
          e.preventDefault();
          const act = b.dataset.act;
          const s = sessions[sessionOf(id)] || {};
          const key = s.embedKey;

          if (act === 'cut') {
            // 关闭内嵌、回到主界面 —— 这就是「无法退出」的正解
            doConnect(id);
            return toast('已关闭 ' + nameOf(id) + ' 的内嵌画面，回到主界面');
          }
          if (!key) return;
          if (act === 'back') window.api.embedBack(key);
          else if (act === 'reload') {
            window.api.embedReload(key);
            toast('已重新加载');
          } else if (act === 'zoom') {
            // 放大这块画面：走和滑块同一套逻辑，保证内嵌视图跟着重新贴合
            // 上限用 sizeMax() 而不是写死 720 —— 高分屏上要能一直放大到吃满整行
            const r = $('#sizeRange');
            cardW = Math.min(sizeMax(), cardW + 120);
            if (r) r.value = cardW;
            // 手动放大 = 放弃列数排布（否则列数模式会把放大后的宽度又均回去）
            exitFit();
            localStorage.setItem(SIZE_KEY, String(cardW));
            toast('已放大画面 · 点右上角「2列 / 3列 / 4列」可重新铺满');
          } else if (act === 'open') {
            // 在系统浏览器里打开同一家AI 的站点，方便看全屏大画面
            const url = s.embedUrl || '';
            if (url) window.open(url, '_blank');
            else toast('这个通道没有可在浏览器打开的网址');
          }
        });
        // 工具条上的拖拽不要被当成抽打
        tools.addEventListener('mousedown', (e) => e.stopPropagation());
      }

      /* 本地 App 窗口捕获工具条：重新捕获 / 切到前台 / 断开 */
      const capTools = el.querySelector('.capture-tools');

      /*
       * 这两个取用器必须定义在**卡片这一层**，不能写到 if (hole) 里面。
       *
       * 踩过的坑：工具条里的「直投/前台」切换按钮在另一个块里，
       * 拿不到只在 if (hole) 内声明的 const —— 点击时直接抛
       * ReferenceError，表现为「按钮点了毫无反应」。块级作用域就这点最坑：
       * 代码看着挨着，作用域却互不相干。
       */
      const sidOf = () => {
        const s = sessions[sessionOf(id)];
        return s && s.sid;
      };

      /*
       * 当前这张卡的注入模式。
       *
       * direct（直投）不移动真实光标、目标被遮挡也可控，是默认值；
       * front（前台）先激活目标再发全局事件，会抢光标，
       * 只对个别不响应直投的应用（多为 Chromium 系）才有必要。
       * 模式由主进程裁决并随 session:state 回传，这里只负责取用与切换。
       */
      const modeOf = () => {
        const s = sessions[sessionOf(id)];
        return (s && s.inputMode) || 'front';
      };

      if (capTools) {
        capTools.addEventListener('click', (e) => {
          const b = e.target.closest('.et-btn');
          if (!b) return;
          e.stopPropagation();
          e.preventDefault();
          const act = b.dataset.act;
          const s = sessions[sessionOf(id)] || {};
          if (act === 'cut') {
            doConnect(id);
            return toast('已断开 ' + nameOf(id) + ' 的窗口捕获');
          }
          if (act === 'recapture') {
            if (!s.sid) return toast('还没连上');
            window.api.captureRecapture(s.sid).then((r) => {
              toast(r && r.ok ? '已重新捕获窗口' : (r && r.msg) || '没找到窗口，请确认应用已打开');
            });
          } else if (act === 'focusapp') {
            // 用系统脚本把它切到前台，方便你自己去看真实窗口
            const nm = (s.appName || nameOf(id) || '').trim();
            if (!nm) return toast('不知道它的应用名');
            window.api.captureFocus(nm, s.pid || 0, true).then((r) => {
              if (r && r.ok) {
                toast('已把 ' + nm + ' 切到前台，正在重新捕获…');
                // 切到前台后窗口必然可见了，立刻重新探测一次
                window.api.captureRecapture(s.sid);
              } else if (r && r.needPermission) {
                toast(r.msg || '需要辅助功能权限');
              } else {
                toast('切换失败：' + ((r && r.msg) || '未知原因'));
              }
            });
          }
        });

        /*
         * 等待态里的「把它切到前台试试」。
         * 解决「应用在跑但窗口最小化 → 抓不到画面」这个最常见的卡死：
         * 窗口一旦到前台，screencapture 就能抓到它了。
         */
        const focusBtn = el.querySelector('[data-cap-focus]');
        if (focusBtn) {
          focusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const sid = focusBtn.dataset.capFocus;
            const sess = sessions[sid];
            if (!sess) return;
            const nm = (sess.appName || nameOf(sess.appId) || '').trim();
            if (!nm) return toast('不知道它的应用名');
            focusBtn.disabled = true;
            focusBtn.textContent = '正在切换…';
            window.api.captureFocus(nm, sess.pid || 0, true).then((r) => {
              focusBtn.disabled = false;
              focusBtn.textContent = '把它切到前台试试';
              if (r && r.ok) {
                toast('已切到前台，正在重新捕获…');
                window.api.captureRecapture(sid);
              } else if (r && r.needPermission) {
                toast(r.msg || '需要辅助功能权限');
              } else {
                toast('切换失败：' + ((r && r.msg) || '未知原因'));
              }
            });
          });
          focusBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        /*
         * 缺「屏幕录制」权限时的专用按钮。
         *
         * 为什么单独做一个：上面那个「切到前台」在权限缺失时完全无效
         * —— 窗口本来就在前台，是系统不放行截图。
         * 让用户点一个注定无效的按钮，只会让人更困惑。
         * 这里直接打开系统设置的对应页面，一步到位。
         */
        const permBtn = el.querySelector('[data-cap-perm]');
        if (permBtn) {
          permBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            window.api.openScreenRecordingSettings().then((r) => {
              if (r && r.ok) toast('已打开系统设置，勾选「网页窗口合集」后需完全退出重开');
              else toast('打不开设置页，请手动到「系统设置 → 隐私与安全性 → 屏幕录制」');
            });
          });
          permBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        /*
         * 缺「辅助功能」权限时的按钮 —— 这是「能看见但点不动」的唯一原因。
         *
         *⚠⚠ 必须和上面那个屏幕录制按钮**分开**：
         *   两个是完全不同的权限，而早期版本只有屏幕录制一个入口。
         *   于是用户勾完屏幕录制，画面出来了，以为万事大吉，
         *   结果点预览画面依然毫无反应 ——
         *   而界面上没有任何东西提示还缺一个权限。
         *
         *   症状与「代码 bug」完全一样，用户只能反复截图反馈，
         *   排查方向被文案直接带偏。这是本项目最耗时的沟通成本之一。
         */
        /*
         * 用 querySelectorAll 而非 querySelector。
         *
         * 这个按钮会出现在多处（工具条、等待区等），而 querySelector
         * 只会返回第一个 —— 多张卡同时接入时，后面几张的按钮点不动，
         * 症状又是「有的卡能授权、有的不能」，极难排查。
         */
        const axBtns = Array.from(el.querySelectorAll('[data-cap-axperm]'));
        axBtns.forEach((axBtn) => {
          axBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            /*
             * 只做两件事：查一次状态 + 打开系统设置页。
             *
             * ⚠ 不要再指望「系统自动弹窗询问」——
             *   那是 AXIsProcessTrustedWithOptions 的功能，
             *   而本机实测该 API 传字典必然 SIGSEGV，
             *   会让整个 App 一点就退出（见 input.mm RequestAccess 注释）。
             *   requestAccess 现在只做安全查询，返回 prompted:false。
             *
             * 打开设置页才是真正有效的动作：
             *   用户勾完完全退出重开，权限即可生效。
             */
            window.api.requestCaptureAx().catch(() => null).then(() => {
              return window.api.openAxSettings();
            }).then((r) => {
              if (r && r.ok) {
                toast('已打开系统设置：把「网页窗口合集」打开，然后完全退出本程序再重开', 4200);
              } else {
                toast('请手动到「系统设置 → 隐私与安全性 → 辅助功能」勾选「网页窗口合集」', 4200);
              }
              /*
               * 清掉权限缓存，让下次状态同步时重新查。
               *
               * ⚠ 用户在系统设置里勾完之后会切回本 App，
               *   这时应该能看到横幅消失 —— 否则即使授权成功了，
               *   界面还在提示缺权限，又变成「界面在骗人」。
               *   （macOS 上权限变更需要 App 重启才完全生效，
               *   但横幅至少不该一直亮着误导人。）
               */
              axGlobal = null;
            }).catch(() => {
              toast('请手动到「系统设置 → 隐私与安全性 → 辅助功能」勾选「网页窗口合集」');
              axGlobal = null;
            });
          });
          axBtn.addEventListener('mousedown', (e) => e.stopPropagation());
        });
        capTools.addEventListener('mousedown', (e) => e.stopPropagation());
      }

      /* ---------------- 捕获画面：可直接点击/拖拽/滚轮操作目标 App ------------- */
      /*
       * ⚠ 为什么这里必须拦掉卡片自身的点击：
       *   预览区的语义从「看着它」变成了「操作它」——
       *   点画面应该点进那个 App，而不是选中卡片 / 切换单卡视图。
       *   之前画面是纯展示，点它只会误触发 el.onclick（选中切换），
       *   用户点十次都是「切了切了视图」，反馈非常迷惑。
       */
      const hole = el.querySelector('.capture-hole');
      if (hole) {
        /*
         * 求「画面里点到的位置」的 0~1 相对坐标。
         *
         * ⚠ 必须算黑边：预览用 object-fit: contain，
         *   窗口不是 16:9 时上下或左右会有留白。
         *   直接用 e.offsetX / 宽 会把黑边也算进去 ——
         *   表现就是「点上面偏上、点下面偏下，越靠边越不准」。
         *
         * 做法：算出 contain 之后的实际绘制矩形，减去偏移再除以尺寸。
         * 拿不到图片真实尺寸时退化为用 hole 自身，此时不会有黑边误差。
         */
        const relOf = (e) => {
          const r = hole.getBoundingClientRect();
          if (!r.width || !r.height) return null;

          const img = hole.querySelector('.capture-img');
          let dw = r.width;
          let dh = r.height;
          if (img && img.naturalWidth && img.naturalHeight) {
            const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
            dw = img.naturalWidth * k;
            dh = img.naturalHeight * k;
          }
          const ox = (r.width - dw) / 2;
          const oy = (r.height - dh) / 2;

          const x = e.clientX - r.left - ox;
          const y = e.clientY - r.top - oy;
          // 点在黑边上就当作无效（不该发生，但边界情况要挡掉）
          if (x < 0 || y < 0 || x > dw || y > dh) return null;

          return { rx: x / dw, ry: y / dh };
        };

        /*
         * 权限只查一次并缓存。
         * 没权限时每次点击都去问系统，既慢又会把用户淹在弹窗里。
         */
        let axChecked = null;
        const ensureAX = () => {
          if (axChecked) return Promise.resolve(axChecked);
          return window.api.captureAX()
            .then((st) => {
              axChecked = st || { granted: false };
              /*
               * ⚠ 必须把结果回写到会话上并重绘，
               *   否则「缺辅助功能权限」的横幅永远不会出现。
               *
               *早期版本的权限只查不显示：用户点画面没反应，
               * 而界面上找不到任何原因说明，
               * 只能靠反复截图反馈 —— 而症状看起来完全像代码 bug。
               *「查得到但看不见」等于没查。
               */
              const ss = sessions[sessionOf(id)];
              /*
               * 以 postEvents（CGPreflightPostEventAccess）为主判据：
               * 它直接回答「能不能把事件投出去」，
               * 而 granted（AXIsProcessTrusted）只回答「设置里勾了没有」。
               * 两者取或，任一为真就不该再提示缺权限（否则界面在骗人）。
               */
              const ok = axUsable(axChecked);
              if (ss && !!ss.axGranted !== ok) {
                ss.axGranted = ok;
                // ⚠ 必须传 S：render(undefined) 会被 `if (!s) return;` 直接吞掉，
                //   表现为「调用了却什么都没变」——静默失败，极难察觉。
                render(S);
              }
              return axChecked;
            })
            .catch(() => {
              axChecked = { granted: false };
              const ss = sessions[sessionOf(id)];
              if (ss && !ss.axGranted) { ss.axGranted = false; render(S); }
              return axChecked;
            });
        };

        /*
         * 悬停：只画一个**本地准星**，绝不向系统注入任何事件。
         *
         * ⚠⚠⚠ 这里曾经是这样写的（并且是用户报「鼠标一靠近预览卡就自己
         *   跑到别处」的**唯一根因**）：
         *
         *     hole.addEventListener('mousemove', e => {
         *       window.api.captureControl({ sid, action: 'move', rx, ry });
         *     });
         *
         *   而主进程侧 action:'move' 最终调的是 CGEventPost(kCGHIDEventTap,
         *   kCGEventMouseMoved)。那是**往系统 HID 流里灌一条鼠标移动** ——
         *   WindowServer 看到「指针位于 (x,y)」，就会把真实光标瞬移过去。
         *
         *   于是因果链是：
         *     用户把鼠标移向预览卡 → 90ms 内光标被瞬移到目标 App 窗口上
         *     → 指针离开预览卡 → mouseleave → 用户的手继续移动
         *     → 指针又被拽回去 …… 光标看起来「自己乱跑」。
         * ⚠ 别把这条和「点不动」当成同一个 bug。
         *
         *   悬停注入确实会**顺带**造成「指针永远停不到画面上、因此点不成」，
         *   删掉它解决的是这一层。
         *   但「点不动」还有一个**独立**成因，删悬停解决不了：
         *   Chromium 会在渲染进程边界过滤合成事件，所以直投
         *   （CGEventPostToPid）对 Electron / 网页类目标是无效的。
         *   那一层靠的是把注入默认模式改成「前台」（见 session.js 顶部注释
         *   与 App 内自检的对照实验记录）。
         *
         *   两处都要在，缺一个症状就会回来。
         *
         *   正确做法：悬停提示是**纯视觉**的事，就该由渲染层自己画。
         *   下面这个准星零 IPC、零系统副作用，光标指哪画哪。
         */
        let capCursor = null;
        const ensureCursor = () => {
          if (capCursor && capCursor.isConnected) return capCursor;
          capCursor = hole.querySelector('.cap-cursor');
          if (!capCursor) {
            capCursor = document.createElement('span');
            capCursor.className = 'cap-cursor';
            capCursor.setAttribute('aria-hidden', 'true');
            hole.appendChild(capCursor);
          }
          return capCursor;
        };

        hole.addEventListener('mousemove', (e) => {
          /*
           * 顺带更新光标语义：空白处可以切全览（zoom-in），
           * 画面内是操作那个 App（crosshair，来自 .capture-hole 默认值）。
           */
          const p = relOf(e);
          hole.classList.toggle('pad-live', !p);

          const cur = ensureCursor();
          const r = hole.getBoundingClientRect();
          if (!p) {
            // 黑边（留白）区不画准星 —— 那里不指向任何目标 App 的位置
            cur.hidden = true;
            return;
          }
          cur.hidden = false;
          cur.style.left = (e.clientX - r.left) + 'px';
          cur.style.top = (e.clientY - r.top) + 'px';
          // 命中时变实，留白时变淡，让「点到哪儿」一眼可见
          cur.classList.toggle('on', true);
        });

        hole.addEventListener('mouseleave', () => {
          hole.classList.remove('live');
          hole.classList.remove('pad-live');
          const cur = hole.querySelector('.cap-cursor');
          if (cur) cur.hidden = true;
        });

        hole.addEventListener('mousedown', (e) => {
          if (e.target.closest('.et-btn') || e.target.closest('button')) return;
          const p = relOf(e);
          /*
           * ⚠⚠ 点在画面外的空白（黑边）上：**必须放行**，让点击冒泡到 el.onclick。
           *
           * 这是「点画面=操作它，点空白=全览/退出全览」这条需求的成败点。
           *
           * 曾经在这里写了 `if (!p) return;` —— 表面上"点了空白没反应"，
           * 实际上是把 el.onclick 一起吞掉了：mousedown 在 hole 上发生，
           * 冒泡到卡片的 onclick 时事件虽然继续上传，但卡片早已被选中状态
           * 之外的逻辑干扰；更关键的是没有任何一条路径会去切换 selected，
           * 于是「点空白进全览 / 再点退出全览」这个功能**彻底消失**，
           * 却又没有任何报错 —— 属于静默功能丢失。
           *
           * 注意这里不能 preventDefault：黑边上的点击要当普通卡片点击处理。
           */
          if (!p) return;
          e.preventDefault();
          e.stopPropagation();

          const sid = sidOf();
          if (!sid) return;

          /*
           * 按下即通知主进程开始拖拽，抬起时带终点 —— 一次完整拖拽只需两次 IPC。
           * 如果做成「移动过程中持续上报」，管线会被几十条消息塞满，
           * 实测反而比两点式更卡。
           */
          const start = { sid, rx: p.rx, ry: p.ry };
          let dragging = false;

          const onMove = (ev) => {
            const q = relOf(ev);
            if (!q) return;
            if (!dragging && Math.abs(q.rx - p.rx) > 0.012
                       || Math.abs(q.ry - p.ry) > 0.012) {
              dragging = true;
            }
            start.rx2 = q.rx;
            start.ry2 = q.ry;
          };

          const onUp = (ev) => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const q = relOf(ev) || {};
            const finalRy = q.ry != null ? q.ry : start.ry2;
            const finalRx = q.rx != null ? q.rx : start.rx2;

            ensureAX().then((st) => {
              /*
               * ⚠ 判定以 postEvents（CGPreflightPostEventAccess）为准，
               *   它是「能不能真的把事件投出去」的系统权威结论。
               *   granted（AXIsProcessTrusted）只反映设置里的勾选状态，
               *   两者不一致时，能发才是真的能发。
               */
              if (!st.granted && !st.postEvents) {
                toast(st.msg || '需要辅助功能权限才能点击它的窗口', 4200);
                return;
              }
              const mode = modeOf();
              if (dragging) {
                window.api.captureControl({
                  sid, action: 'drag', mode,
                  rx: start.rx, ry: start.ry,
                  rx2: finalRx, ry2: finalRy
                }).then((r) => {
                  if (r && r.needPermission) toast(r.msg);
                  else if (r && !r.ok) toast(r.msg || '拖不动它的窗口');
                });
              } else {
                window.api.captureControl({
                  sid, action: 'click', mode,
                  rx: finalRx, ry: finalRy,
                  right: e.button === 2,
                  count: e.detail >= 3 ? 3 : e.detail === 2 ? 2 : 1
                }).then((r) => {
                  if (r && r.needPermission) toast(r.msg);
                  else if (r && !r.ok) toast(r.msg || '点不动它的窗口');
                });
              }
            });
          };

          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });

        /* 滚轮：直接滚它的窗口 */
        hole.addEventListener('wheel', (e) => {
          const p = relOf(e);
          if (!p) return;
          e.preventDefault();
          e.stopPropagation();
          const sid = sidOf();
          if (!sid) return;
          // deltaY 为正表示往下滚，这里取反成「往下滚 = 内容向上」
          window.api.captureControl({
            sid, action: 'scroll', mode: modeOf(), rx: p.rx, ry: p.ry,
            dy: e.deltaY > 0 ? -3 : 3
          }).catch(() => {});
        }, { passive: false });

        /* 右键菜单会盖住它的窗口，必须拦掉 */
        hole.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        // 悬停时给出「这个画面可以操作」的暗示
        hole.addEventListener('mouseenter', () => hole.classList.add('live'));

        /*
         * 空白区 =画面之外的留白（object-fit: contain 产生的黑边）。
         *
         * 需求：点画面内→ 操作那个 App；点空白 → 单卡全览 / 退出全览。
         *
         *⚠ 这里刻意**不**依赖事件冒泡去触发 el.onclick，而是自己实现：
         *   冒泡路径上还有 capTools、输入框等多层拦截，
         *   任何一层将来加了 stopPropagation 都会让这个功能静默失效。
         *   自己实现虽然看似重复，但把行为锁死在这里，不受上层改动影响。
         *
         * 而画面**内**的区域不能这么做，否则点了 AI 的按钮
         * 会被误判成「切全览」—— 那才是真正的灾难（用户点了发送，
         * 结果整个界面被切走，完全不知道发生了什么）。
         */
        hole.addEventListener('click', (e) => {
          if (e.target.closest('.et-btn') || e.target.closest('button')) return;
          // 点在画面内 → 已交给 captureControl，必须截断冒泡，不能再触发卡片放大。
          if (relOf(e)) {
            e.stopPropagation();
            return;
          }
          selected = selected === id ? null : id;
          render(S);
          renderRoster();
        });
      }

      // 卡内输入。用委托绑定到 wall，避免每次重绘丢失焦点与已输入内容。
      const inp = el.querySelector('.vin');
      if (inp) {
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key !== 'Enter') return;
          const v = inp.value.trim();
          if (!v) return;
          inp.value = '';
          sendTo(id, v);
        });
        inp.addEventListener('click', (e) => e.stopPropagation());
      }
      /*
       * 预览卡本体不再承担抽打：它只是「看它干活」的画面。
       * 抽打只在顶部角色框发生。
       *
       * 点击语义（用户需求：单击任意一个 AI 界面 → 它填满显示框）：
       *   点未选中的卡 → 选中它，进入单卡填满模式
       *   点已选中的卡 → 取消选中，回到「显示所有」的网格
       * 也就是同一张卡再点一次就能退出，不会把人困在单卡视图里。
       */
      el.onclick = () => {
        // 长按拖完松手的那一下会冒 click，吞掉，别把「拖动」变成「切单卡」
        if (justDragged) return;
        selected = selected === id ? null : id;
        render(S);
        renderRoster();
      };
    });

    // 把重绘前的焦点与已输入内容搬回来，避免打字打到一半被清空
    if (focusMemo && focusMemo.sid) {
      const still = document.querySelector(`.vcard[data-app="${focusMemo.appId}"] .vin`);
      if (still) {
        still.value = focusMemo.value;
        still.focus();
        const len = focusMemo.value.length;
        try { still.setSelectionRange(len, len); } catch (e) {}
      }
    }

    // 恢复每个卡的滚动位置
    list.forEach((c) => {
      const sid = sessionOf(c.id);
      if (!sid) return;
      const body = wall.querySelector(`.vcard[data-app="${c.id}"] .vlines`);
      if (body) body.scrollTop = body.scrollHeight;
    });
  }

  function vcardHtml(c) {
    const top = (c.activeTasks || [])[0] || null;
    const sid = sessionOf(c.id);
    const s = sid ? sessions[sid] : null;
    // 进度来源：观察通道的推断结果优先，其次才是引擎内部任务
    const watchPct = s && s.channel === 'watch' && typeof s.progress === 'number' ? s.progress : null;
    const pct = watchPct != null ? watchPct : top ? Math.round(top.progress) : 0;
    const hpPct = hpPctOf(c.hp, c.maxHp);
    const hp = hpPct.shown;
    // 状态文案与色调同样跟着血条档位走，和造型保持一致
    const art = hpArt(hpPct.exact);
    const st =
      watchPct != null
        ? '产物观察 ' + pct + '%'
        : STATE_LABEL[art] || art;
    const ch = (scan && scan.best && scan.best[c.id]) || null;
    const tone = TONE[art] || 'transparent';

    // 画面区分三种形态：
    //   内嵌 —— 真实的 AI 网页版，WebContentsView 会精确盖在这个占位 div 上
    //   流式 —— CLI / 观察通道的文本输出
    //   待机 —— 未接入，画面留白
    let frame;
    if (s && s.status !== 'closed') {
      if (s.channel === 'embed') {
        // 结构说明：纵向 flex 切成两段——工具条 / 画面区。
        // 原生视图只覆盖中间的 .embed-hole，所以工具条能正常点到。
        // 不再有「对 XX 说话」输入条：要说话直接在下面的真实页面里打字，
        // 那个输入框本来就是它自己的，多一层反而让人不知道该往哪写。
        const tabs = Array.isArray(s.embedTabs) && s.embedTabs.length ? s.embedTabs : [{ key: s.embedKey, title: s.name, url: s.embedUrl }];
        frame = `<div class="vscene embed-scene">
          <div class="embed-tabs" data-tabs="${c.id}" title="点标签切换页面 · 单击空白处进全视窗 · 长按空白处拖动">
            ${tabs.map((t) => `<button class="embed-tab ${t.key === s.embedKey ? 'active' : ''}" data-tab-key="${escapeAttr(t.key)}" title="${escapeAttr(t.url || '')}">${escapeHtml(t.title || t.url || '网页')}<span class="embed-tab-x" data-tab-close="${escapeAttr(t.key)}">×</span></button>`).join('')}
            <button class="embed-tab-add" data-tab-add="1" title="新建标签页">＋</button>
          </div>
          <div class="embed-tools" data-tools="${c.id}">
            <button class="et-btn" data-act="back" title="后退一步">‹</button>
            <button class="et-btn" data-act="reload" title="重新加载">↻</button>
            <button class="et-btn" data-act="zoom" title="放大这个画面">⤢</button>
            <button class="et-btn" data-act="open" title="用系统浏览器打开">↗</button>
            <button class="et-btn danger" data-act="cut" title="关闭内嵌，回到主界面">✕</button>
          </div>
          <div class="embed-hole" data-embed-key="${s.embedKey || ''}" data-app="${c.id}"></div>
        </div>`;
      } else if (s.channel === 'capture') {
        // 本地桌面 App 的窗口捕获：把它的真实窗口画面搬进这张卡。
        // 用 <img> 而不是 <canvas>：画面是 PNG 快照，直接换src 成本最低，
        // 且不需要自己管理绘制循环（这里 1.2s 一帧，人眼察觉不到闪烁）。
        frame = `<div class="vscene capture-scene">
          <div class="capture-tools" data-tools="${c.id}">
            <span class="cap-badge">${
            // ⚠ 如实区分「实时流」和「低频降级」。
            //   两者都写着「实时画面」的话，降级时用户会一直以为程序卡住了 ——
            //   实际上它只是退回了 700ms 一帧的老路。
            s.streamMode === 'fallback'
              ? '本机 App · 低频画面'
              : '本机 App 实时画面 · 可直接点击操作'
          }</span>
            ${
              /*
               * ⚠⚠ 辅助功能权限按钮必须放在**工具条**里，不能放在下面的
               *   「等待画面」区块中。
               *
               * 早期版本把它写在 cap-wait 里，而 cap-wait 只在
               *     s.frameData ? <img> : <div class="cap-wait">
               * 的else 分支渲染 ——
               *   也就是**只有抓不到画面时才出现**。
               *
               * 但「需要辅助功能」的场景恰恰是**画面已经能看见、只是点不动**，
               * 此时 frameData 已有值 → 走img 分支 → 按钮消失。
               *
               * 结果形成逻辑死结：
               *   缺权限 → 按钮不显示 → 用户找不到入口 → 无法授权 → 一直点不动
               * 我曾让用户「点预览卡右上角的开启鼠标操作按钮」，
               * 而那个按钮在他遇到问题时**永远不可能出现**。
               *
               * 工具条是常驻的，不随画面有无变化，所以放这里。
               */
              !s.axGranted && !s.readonly
                ? `<button class="btn cap-ax-btn" data-cap-axperm="1"
                     title="当前只能看、点不动。点我去开启系统辅助功能权限">🖱 开启鼠标操作</button>`
                : ''
            }
            <button class="et-btn" data-act="recapture" title="重新捕获窗口">↻</button>
            <button class="et-btn" data-act="focusapp" title="把${escapeAttr(
              nameOfChar(c)
            )} 切到前台">↗</button>
            <button class="et-btn danger" data-act="cut" title="断开捕获">✕</button>
          </div>
          <div class="capture-hole" data-capture="${s.sid}">
            ${
              s.frameData
                ? `<img class="capture-img" src="${s.frameData}" alt="${escapeAttr(
                    nameOfChar(c)
                  )} 的实时画面" />`
                : `<div class="cap-wait">
                     <span class="cap-wait-t">${
                       // 标题要区分「没找到窗口」和「找到了但抓不下来」——
                       // 后者通常是屏幕录制权限缺失（实测最常见），
                       // 都说成「正在捕获…」会让人一直等下去。
                       s.readonly
                         ? (/屏幕录制|截图/.test(s.capNote || '')
                             ? '系统拒绝了窗口截图'
                             : '还没抓到它的窗口')
                         : '正在捕获窗口画面…'
                     }</span>
                     ${
                       s.readonly
                         ? `<span class="cap-wait-s">${
                             // 主进程带回失败原因，直接告诉用户该做什么，
                             // 而不是只让他猜（原来这里只有一句干巴巴的提示）
                             escapeHtml(
                               s.capNote ||
                                 ('把' + nameOfChar(c) + ' 打开一次，或点右上角 ↻ 重新捕获')
                             )
                           }</span>`
                         : ''
                     }
                     ${
                       s.readonly
                         ? (() => {
                             // 缺屏幕录制权限时，「切到前台」完全没用
                             // （窗口本来就在那儿，是系统不放行截图），
                             // 这时给一键打开对应设置页才有效。
                             const isPerm = /屏幕录制|截图/.test(s.capNote || '');
                             return `<span class="cap-wait-a"><button class="btn" ${
                               isPerm
                                 ? 'data-cap-perm="1"'
                                 : `data-cap-focus="${s.sid}"`
                             }>${isPerm ? '去开启屏幕录制' : '把它切到前台试试'}</button></span>`;
                           })()
                         : ''
                     }
                     ${
                       // 辅助功能权限按钮已移到常驻工具条（见上方 capture-tools）。
                       //
                       // 这里曾经也放一份，但整个 cap-wait 只在**抓不到画面**时渲染，
                       // 而缺辅助功能时画面通常是能看见的 —— 按钮恰好在最需要时消失。
                       // 保留两处只会让人更困惑：工具条上没有，等待区也没有。
                       ''
                     }
                   </div>`
            }
          </div>
        </div>`;
      } else {
        const canWrite = s.channel === 'cli';
        frame = `<div class="vscene">
        <div class="vlines" data-sid="${s.sid}">${
          s.lines.length
            ? s.lines
                .slice(-160)
                .map((l) => `<div class="${LVL_CLS[l.level] || ''}">${escapeHtml(l.text)}</div>`)
                .join('')
            : `<div class="l-empty">等待输出…</div>`
        }</div>
        ${
          canWrite && s.status === 'live'
            ? `<div class="vinput"><span class="pfx">❯</span><input class="vin" placeholder="往这里打字，回车发送…" autocomplete="off" /></div>`
            : ''
        }
      </div>`;
      }
    } else {
      // 未接入时不显示任何角色画面 —— 没有真实 AI 在跑，就不该有个"假的它"在画里。
      // 只留一块干净的待机区 + 接入入口。
      frame = `<div class="vfigure idle">
        <div class="vvoid">
          <span class="vtip">${ch ? '未接入 · 在左侧角色板点「＋」接入' : '本机未检测到'}</span>
          ${ch ? '' : '<span class="vlink">装好应用后点「重新扫描」</span>'}
        </div>
      </div>`;
    }

    return `<div class="vcard ${selected === c.id ? 'sel' : ''}" data-app="${c.id}" style="--tone:${tone};--hp-c:${hpColor(c.id)}">
      <div class="vframe">${frame}</div>
      <div class="vinfo" style="--tone:${tone}">
        <span class="vi-name">${escapeHtml(nameOfChar(c))}</span>
        <span class="vi-state">${escapeHtml(st)}</span>
        <div class="vi-bars">
          <div class="vbar task"><i style="width:${pct}%"></i></div>
          <div class="vbar hp"><i class="${hpCls(hp, art)}" style="width:${hp}%"></i></div>
        </div>
        <span class="vi-pct">${pct}%</span>
        <button class="vlink-btn ${sid ? 'linked' : ''}" title="${
          sid ? '断开' : ch ? '接入 ' + nameOfChar(c) : '本机未安装'
        }" ${ch || sid ? '' : 'disabled'}>${sid ? '●' : '⏻'}</button>
        <button class="vrename-btn" data-app="${c.id}" title="属性：改名字 / 换形象（当前：${escapeAttr(nameOfChar(c))})">✎</button>
      </div>
    </div>`;
  }

  /** 局部更新某张卡的实时输出（高频事件，避免重建 DOM） */
  function updateVcardLines(appId) {
    const sid = sessionOf(appId);
    if (!sid) return;
    const body = document.querySelector(`.vcard[data-app="${appId}"] .vlines`);
    if (!body) return;
    const s = sessions[sid];
    if (!s) return;
    body.innerHTML = s.lines.length
      ? s.lines
          .slice(-160)
          .map((l) => `<div class="${LVL_CLS[l.level] || ''}">${escapeHtml(l.text)}</div>`)
          .join('')
      : `<div class="l-empty">等待输出…</div>`;
    body.scrollTop = body.scrollHeight;
  }

  /* ---------------- 内嵌视图定位 ---------------- */

  /**
   * 求「内嵌洞」在窗口里的真实可见矩形。
   *
   * ⚠ 这是修「AI 窗口突出整个窗口」的关键。
   *
   * WebContentsView 是一层**原生视图**，它完全不受 DOM 的 overflow 裁剪约束：
   * 卡片在 .wall-scroll 里只露出半张时，DOM 会被滚动容器裁掉，
   * 但原生视图仍然按完整矩形绘制，于是它直接糊在道具栏、状态栏上，
   * 甚至糊到窗口边界之外。
   *
   * 所以不能直接用 hole.getBoundingClientRect()，必须把它和
   * **滚动容器的可视矩形**求交集，得到的才是「用户真正能看到的那一块」。
   * 同时带上 fitW = 卡片本身的宽度，供主进程算等比缩放（见 embed.js tuneViewport）。
   */
  function embedClipRect(hole) {
    const r = hole.getBoundingClientRect();
    const scroller = $('#wallScroll');
    // 没有滚动容器时退化为窗口视口
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth };

    const top = Math.max(r.top, box.top);
    const bottom = Math.min(r.bottom, box.bottom);
    const left = Math.max(r.left, box.left);
    const right = Math.min(r.right, box.right);

    // ⌘ +/- 会改变页面缩放：getBoundingClientRect 是 CSS 像素，
    // 而 WebContentsView.setBounds 用的是设备无关像素，不换算就会错位。
    const z = window.api && typeof window.api.zoom === 'function' ? window.api.zoom() : 1;
    const zf = z > 0.05 ? z : 1;

    /*
     * ⚠ 把四条边先对齐到**整数 DIP**（设备无关像素），再乘 zf。
     *
     * 为什么：原生视图的位置只能落在整数 DIP 上，而页面布局是小数像素
     * （卡片宽 453.33、滚动偏移带小数都会传导过来）。不对齐的话，
     * 视图要么比洞小半像素 → 洞的白底从缝里透出来（白边），
     * 要么比洞大半像素 → 反过来盖住工具条/信息条一条边。
     *
     * 先在渲染层对齐、主进程再做一次**同样的四舍五入**，
     * 两边算出来的矩形完全一致 —— 这是恒等变换，既不留缝也不外溢。
     * （上一版是主进程「向外取整」保证覆盖，但那样必然多出半像素压到
     *   相邻的深色工具条上，反而变成一条白线 —— 用户看到的就是这个。）
     */
    const snap = (v) => Math.round(v * zf) / zf;
    const L = snap(left);
    const T = snap(top);
    const R = snap(right);
    const B = snap(bottom);

    const w = (R - L) * zf;
    const h = (B - T) * zf;
    // 露出不足 8px（等于没有）就收掉，避免留一条挡点击的缝
    if (w < 8 || h < 8) return null;
    /*
     * fitW（主进程算缩放的基准宽）必须是「用户实际看得到的宽度」。
     *
     * 正常态洞不会比滚动可视区宽，Math.min 不起作用，行为与旧版完全一致
     * （竖向只露出半张的卡片仍按卡片全宽缩放，见 embed.js tuneViewport 的说明）。
     *
     * 但只要洞因任何原因横向溢出了可视区 —— 典型是 solo ↔ 多卡切换的
     * 过渡帧量到了中间态、视图停在旧尺寸 —— 旧版仍按洞的全宽算缩放，
     * 页面布局就会比可见区宽，右侧永远缺一条（用户截图里「切出单独
     * 页面后右侧部分不可见」的直接成因）。这里钳到可见宽后，即便布局
     * 出现异常态，页面也会完整缩进看得见的范围里，后续重拍自会纠偏。
     */
    const fitW = Math.min(r.width * zf, w);
    return {
      x: L * zf, y: T * zf, width: w, height: h, fitW,
      // 诊断字段（embed-fit.log 的 geom 行用）：裁剪前的洞原始矩形（DIP）、
      // 主机视口与页面缩放 —— 「页面自报完整但用户看到缺角」时，
      // 靠这一行分辨是洞量错了还是视图摆错了。
      raw: { x: r.left * zf, y: r.top * zf, w: r.width * zf, h: r.height * zf },
      zf, hiw: window.innerWidth, hih: window.innerHeight,
    };
  }

  /**
   * 把内嵌视图的坐标同步给主进程。
   *
   * WebContentsView 是独立于页面的一层原生视图，位置不会自己跟着布局走，
   * 所以每次布局变化（重绘、滚动、缩放、窗口resize）都必须重新报一次坐标，
   * 否则它会「浮」在错误位置挡住界面，或缩在旧位置不跟卡片。
   *
   * getBoundingClientRect 给的是视口坐标；由于页面本身不滚动
   * （html/body overflow:hidden，滚动发生在 .wall-scroll 内部），
   * 视口坐标就是窗口内绝对坐标，不需要再加文档滚动偏移。
   */
  function syncEmbedBounds() {
    const holes = $$('.embed-hole');

    /*
     * ⚠ 先上报「本轮存活名单」，这是修「点开一个 AI 后其他 AI 界面残留」的关键。
     *
     * 复现：豆包和 Kimi 都已接入，两个原生视图都在显示。
     * 用户单击豆包卡片 →渲染层只保留豆包那张卡，Kimi 的 .embed-hole
     * 从 DOM 里消失了。但 WebContentsView 是**独立于 DOM 的原生层**，
     * DOM 元素被删不会连带把它收走 —— 它仍按上一次的 bounds 浮在窗口上，
     * 于是用户看到「选中了豆包，KIMI 的画面还残留在旁边」。
     *
     * 之前只在「洞还存在」时调 setBounds，洞没了就没人能通知主进程收它，
     * 于是它永远停在旧位置。改成把存活名单整体上报，
     * 让主进程按白名单收走其余所有视图（见 embed.js retainOnly）。
     */
    const liveKeys = holes.map((h) => h.dataset.embedKey).filter(Boolean);
    if (window.api && typeof window.api.embedRetain === 'function') {
      window.api.embedRetain(liveKeys);
    }

    // 弹窗/遮罩打开时，一律把所有内嵌视图收成 0 尺寸。
    // WebContentsView 是独立于 DOM 的**原生层**，z-index 再高也压不住它：
    // 不收掉的话，已接入的 AI 界面会直接浮在弹窗上方（用户看到的「添加应用时把
    // AI 界面一起显示出来了」）。这里统一收，收完立刻 return，避免被下面的分支改回去。
    if (embedsSuppressed) {
      holes.forEach((hole) => {
        const key = hole.dataset.embedKey;
        if (key) window.api.embedBounds(key, { x: 0, y: 0, width: 0, height: 0 });
      });
      return;
    }

    holes.forEach((hole) => {
      const key = hole.dataset.embedKey;
      if (!key) return;
      const c = embedClipRect(hole);
      window.api.embedBounds(key, c || { x: 0, y: 0, width: 0, height: 0 });
    });
  }

  /** 布局变化后延迟一拍再同步，避免在重绘中途读到旧尺寸 */
  function scheduleSync() {
    if (syncEmbedBounds._t) clearTimeout(syncEmbedBounds._t);
    syncEmbedBounds._t = setTimeout(() => {
      syncEmbedBounds._t = null;
      syncEmbedBounds();
    }, 60);
  }

  /**
   * 滚动时用的即时同步（rAF 节流）。
   *
   * 滚动不能走 scheduleSync 的 60ms 防抖：原生视图比 DOM 慢半拍，
   * 用户会看到画面「跟不上」滚动，甚至在停手后还继续错位一小段。
   * rAF 保证一帧只报一次坐标，既跟手又不重复计算。
   */
  function syncOnFrame() {
    if (syncOnFrame._raf) return;
    syncOnFrame._raf = requestAnimationFrame(() => {
      syncOnFrame._raf = 0;
      syncEmbedBounds();
    });
  }

  /* ---------------- 监视器卡片拖动排序 ----------------
   *
   * 用户需求：长按 AI 监视器「标签条空白处」→ 拖起整张监视器卡，
   * 自由调整它在墙上的位置；其余卡片实时让位（自动排列），
   * 松手后顺序落盘（localStorage），重绘/重启都保持。
   *
   * 为什么不用 HTML5 Drag & Drop：它的 ghost 样式不可控、
   * 和 WebContentsView 原生层叠在一起时 drop 提示会闪烁，
   * 而且长按语义（按住不动才触发）用 pointer 事件更好做。
   */

  const DRAG_LP_MS = 420;    // 长按多久才判定为「要拖动」
  const DRAG_SLIP_PX = 9;    // 长按生效前位移超过这个 = 误触/滚动，取消

  function bindWallDrag() {
    const wallEl = $('#wall');
    if (!wallEl) return;

    wallEl.addEventListener('pointerdown', (e) => {
      if (wallDrag || e.button !== 0) return;
      /*
       * 热区 = 标签条 + 工具条整块（用户需求：两个栏的交互合并）。
       *   空白处单击 → 进/出全视窗（各栏自己的 click 里做）
       *   空白处长按 → 拖动整张监视器卡
       * 标签按钮 / 新建「＋」/ 工具按钮有自己的点击语义，不能被拖动手势抢走。
       */
      const bar = e.target.closest('.embed-tabs, .embed-tools');
      const card = e.target.closest('.vcard');
      if (!bar || !card || !wallEl.contains(card)) return;
      if (e.target.closest('.embed-tab') || e.target.closest('.embed-tab-add') || e.target.closest('.et-btn')) return;
      /*
       * ⚠ 这里刻意不调 e.preventDefault()。
       *
       * pointerdown 上的 preventDefault 会牵连同一次按下的兼容性鼠标事件链，
       * 是「空白处单击进全视窗」时灵时不灵的隐患。按住拖动时的防选中
       * 改由 CSS 承担：.embed-tabs / .embed-tools 都是 user-select: none
       * （见 styles.css），不依赖 JS 拦默认行为。
       */

      const sx = e.clientX;
      const sy = e.clientY;
      const cancel = () => {
        clearTimeout(timer);
        window.removeEventListener('pointermove', onSlip);
        window.removeEventListener('pointerup', onCancel);
        window.removeEventListener('pointercancel', onCancel);
      };
      const onSlip = (ev) => {
        if (wallDrag) return;
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > DRAG_SLIP_PX) cancel();
      };
      const onCancel = () => cancel();
      const timer = setTimeout(() => {
        cancel();
        startWallDrag(card, e);
      }, DRAG_LP_MS);
      window.addEventListener('pointermove', onSlip);
      window.addEventListener('pointerup', onCancel);
      window.addEventListener('pointercancel', onCancel);
    });
  }

  function startWallDrag(card, e) {
    if (wallDrag) return;
    const r = card.getBoundingClientRect();
    // ghost 用整卡克隆：拖动时手里拎着的就是「这张监视器」的样子
    const ghost = card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    card.classList.add('drag-src');
    document.body.classList.add('wall-dragging');
    wallDrag = { el: card, ghost, dx: e.clientX - r.left, dy: e.clientY - r.top };
    moveWallDrag(e);
    window.addEventListener('pointermove', onWallDragMove);
    window.addEventListener('pointerup', onWallDragUp);
    window.addEventListener('pointercancel', onWallDragUp);
    toast('已抓起监视器 · 拖到想要的位置松手');
  }

  function onWallDragMove(e) {
    if (!wallDrag) return;
    e.preventDefault();
    moveWallDrag(e);
  }

  function moveWallDrag(e) {
    wallDrag.ghost.style.transform =
      'translate(' + (e.clientX - wallDrag.dx) + 'px,' + (e.clientY - wallDrag.dy) + 'px)';
    // 自动排列：指针压到哪张卡的左/右半边，就把源卡实时挪到它前/后。
    // flex 布局会让其余卡片立刻让位，这就是「拖动中就自动排列」。
    const cards = $$('#wall .vcard').filter((el) => el !== wallDrag.el);
    const wallEl = $('#wall');
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      // 纵向有 24px 容差带，横向才判断左右半边 —— 斜着拖也顺手
      if (e.clientY < r.top - 24 || e.clientY > r.bottom + 24) continue;
      const before = e.clientX < r.left + r.width / 2;
      // 已经在目标位置就不挪（避免每帧无意义地动 DOM）
      if (before ? el.previousSibling === wallDrag.el : el.nextSibling === wallDrag.el) break;
      wallEl.insertBefore(wallDrag.el, before ? el : el.nextSibling);
      // 洞跟着 DOM 挪了，原生视图要重新贴合（防抖一拍即可）
      scheduleSync();
      break;
    }
  }

  function onWallDragUp() {
    if (!wallDrag) return;
    const d = wallDrag;
    wallDrag = null;
    window.removeEventListener('pointermove', onWallDragMove);
    window.removeEventListener('pointerup', onWallDragUp);
    window.removeEventListener('pointercancel', onWallDragUp);
    d.ghost.remove();
    d.el.classList.remove('drag-src');
    document.body.classList.remove('wall-dragging');
    // 从当前 DOM 顺序落盘成新排序，renderWall 会按它重排 —— 重启也保持
    wallOrder = $$('#wall .vcard').map((el) => el.dataset.app).filter(Boolean);
    try { localStorage.setItem(WALL_ORDER_KEY, JSON.stringify(wallOrder)); } catch (e) {}
    // 松手那一下通常还会冒 click，短暂吞掉，别误触「单卡填满」
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 350);
    renderWall(S);
    toast('监视器顺序已保存');
  }

  /** 往指定角色的会话写输入 */
  async function sendTo(appId, text) {
    const sid = sessionOf(appId);
    if (!sid) return toast('还没接入，无法发送');
    const s = sessions[sid];
    if (s.status === 'closed') return toast('会话已结束');
    const r = await window.api.sessionWrite(sid, text);
    if (r && r.ok === false) toast(r.msg || '写入失败');
    updateVcardLines(appId);
  }

  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  }

  function timeAgo(t) {
    const d = Math.floor((Date.now() - t) / 1000);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + '分前';
    return Math.floor(d / 3600) + '小时前';
  }

  /* ---------------- 抽打 ---------------- */

  async function doHit(appId, ev) {
    if (tool === 'normal') {
      selected = appId;
      render(S);
      return;
    }

    // 门禁：必须先扫描并连接，才能抽打。
    // 理由——抽打是对「一个正在干活的 AI」施加动作。
    // 如果它根本没接进来，打下去只是动画，没有任何真实作用，
    // 用户会以为程序坏了。所以这里明确拦下并引导去连接。
    if (!connected.has(appId)) {
      const ch = (scan && scan.best && scan.best[appId]) || null;
      if (!scan) {
        return toast('正在扫描本机 AI 应用，请稍候…');
      }
      if (!ch) {
        return toast('本机没有检测到可连接的 ' + nameOf(appId) + '，先装好或点右上角重新扫描');
      }
      toast('还没接入 ' + nameOf(appId) + ' —— 先点右下角 ⏻ 接入，再动手');
      // 直接帮他连上，省得再找按钮
      return doConnect(appId);
    }

    const char = byId(appId);
    const res = await window.api.hit(appId, tool);
    if (!res || !res.ok) return;

    const isHeal = res.toolKind === 'heal';

    // 定位：靶子是顶部角色框。特效原点取鼠标位置（跟着手走），
    // 没有鼠标事件时退化为框中心。
    const box = document.querySelector(`.rbox[data-app="${appId}"]`);
    const br = box ? box.getBoundingClientRect() : null;
    const cx = br ? br.left + br.width / 2 : innerWidth / 2;
    const cy = br ? br.top + br.height / 2 : innerHeight / 2;
    const x = ev && ev.clientX ? ev.clientX : cx;
    const y = ev && ev.clientY ? ev.clientY : cy;

    /* ---- 粒子层：所有效果都裁剪在这个角色框内 ---- */
    const clip = rosterClip(appId);
    const power = Math.min(1.6, isHeal ? 0.6 : res.combo / 4 + 0.5);
    const realDelta = typeof res.hpDelta === 'number' ? res.hpDelta : isHeal ? dmgOf(tool) : -dmgOf(tool);
    // 第 6 参传工具 id：特效层有该武器的视频精灵图就播视频动画，
    // 没有（皮鞭）回落旧程序化特效。
    fx.hit(x, y, res.toolKind, power, clip, tool);
    shakeCursor();     // 光标（武器图形）抖一下 —— 打击反馈不再依赖命中点动画
    if (!isHeal) {
      fx.text(x, y - 40, '-' + dmgText(realDelta), '#C1553E', res.combo >= 3, clip);
      if (res.combo >= 3) fx.combo(cx, cy - 46, res.combo, clip);
      fx.flash('#A8432A', power);
    } else {
      fx.text(x, y - 40, '+' + dmgText(realDelta), '#2E6B4F', false, clip);
      fx.flash('#2E6B4F', 0.6);
    }

    /* ---- 角色框层：击打动画 + 扣血 ----
     * 目标：除了表情变化，还要让人「看见这一下打掉了多少血」。
     * 四件事同时发生：
     *   1. 整框红白闪光      —— 交代命中
     *   2. 从命中点扩散冲击环 —— 交代打击点位置
     *   3. 扣血飘字 + HP 数字立刻掉 —— 交代伤害量
     *   4. 抖动 + 形象挤压形变 —— 交代打击感
     */
    if (box) {
      // 伤害取真实血量差值：hpDelta < 0 表示掉血，> 0 表示回血。
      // 拿不到差值时退回武器标称值。
      const delta = typeof res.hpDelta === 'number' ? res.hpDelta : isHeal ? dmgOf(tool) : -dmgOf(tool);
      const dmg = dmgText(delta);

      // 1) 冲击环从鼠标命中的位置长出来（换算成框内坐标）
      const shock = document.createElement('span');
      shock.className = 'rb-shock';
      const lx = br ? Math.max(0, Math.min(br.width, x - br.left)) : br ? br.width / 2 : 0;
      const ly = br ? Math.max(0, Math.min(br.height, y - br.top)) : br ? br.height / 2 : 0;
      shock.style.left = lx + 'px';
      shock.style.top = ly + 'px';
      box.appendChild(shock);
      setTimeout(() => shock.remove(), 460);

      // 2) 扣血 / 回血飘字
      const dmgEl = box.querySelector('[data-dmg]');
      if (dmgEl) {
        dmgEl.textContent = isHeal ? '+' + dmg : '-' + dmg;
        dmgEl.classList.remove('go', 'heal');
        void dmgEl.offsetWidth;
        dmgEl.classList.add('go');
        if (isHeal) dmgEl.classList.add('heal');
      }

      // 3) 连击计数
      const comboEl = box.querySelector('[data-combo]');
      if (comboEl) {
        if (res.combo >= 2) {
          comboEl.textContent = res.combo + ' 连击';
          comboEl.classList.remove('go');
          void comboEl.offsetWidth;
          comboEl.classList.add('go');
        }
      }

      // 4) HP 立即回写，不等下一次 320ms 快照 ——
      //    打完还能看清数字已经变了，才叫「扣血」
      const np = res.hp != null && res.maxHp ? hpPctOf(res.hp, res.maxHp) : null;
      const newHp = np ? np.shown : null;
      if (np) {
        const dead = np.exact <= 0;   // 真·阵亡才算 down，别把「只剩 0.4 血」当死
        const hpEl = box.querySelector('[data-hp]');
        const ghost = box.querySelector('[data-ghost]');
        const num = box.querySelector('[data-hpnum]');
        if (hpEl) {
          hpEl.style.width = newHp + '%';
          hpEl.classList.toggle('down', dead);
          hpEl.classList.toggle('low', !dead && newHp < 35);
        }
        if (num) {
          num.textContent = newHp;
          num.classList.toggle('down', dead);
          num.classList.toggle('low', !dead && newHp < 35);
        }
        if (ghost) {
          // 残影槽延迟 90ms 再收：真实血条已经掉了，ghost 还停在旧长度，
          // 那截红槽就是「被削掉的血」，随后一起回落。
          // 回调在 90ms 后才跑，必须重新查一次并判空 —— 中途若角色框被重建，
          // 拿着旧引用写 style 会抛 TypeError。
          setTimeout(() => {
            const g2 = box.isConnected ? box.querySelector('[data-ghost]') : null;
            if (g2) g2.style.width = newHp + '%';
          }, 90);
        }
      }

      // 5) 抖动 + 形象挤压形变
      box.classList.remove('is-hit');
      void box.offsetWidth;
      box.classList.add('is-hit');
      setTimeout(() => box.classList.remove('is-hit'), 340);

      const svg = box.querySelector('.rb-fig svg');
      if (svg) {
        svg.classList.remove('hit');
        void svg.getBoundingClientRect();
        svg.classList.add('hit');
        // hit.png 是「被打」那张设计图，整图盖住底图闪现。
        // 2026-10-12：造型改成按血条档位显示后，hit 只作为打击反馈，
        // 时长在 820ms 基础上再砍一半 —— 一闪而过，不抢走档位造型的存在感。
        setTimeout(() => svg.classList.remove('hit'), 410);
      }

      // 6) 朝鼠标方向歪一下（像被打得偏过去）
      const kx = ((x - cx) / (br.width || 1)) * 8;
      const ky = ((y - cy) / (br.height || 1)) * 6;
      box.style.setProperty('--knock-x', (-kx).toFixed(1) + 'px');
      box.style.setProperty('--knock-y', (-ky).toFixed(1) + 'px');
    }

    /* ---- 音效 ---- */
    /*
     * 2026-10-12 第三轮用户要求：**每个道具只出「自己那一声」**。
     * 之前每次打击都在道具音后面再补一记 whimper，听下来满耳朵都是呜咽 ——
     * 呜咽属于「被打崩」那一刻（血条清零），不属于每一次普通打击。
     * 皮鞭也从「借水枪声」改回自己的抽打声。
     */
    SFX.play(
      res.toolKind === 'lash' ? 'whip'
      : res.toolKind === 'wet' ? 'water'
      : res.toolKind === 'shot' ? 'gun'
      : res.toolKind === 'gatling' ? 'gatling'
      : res.toolKind === 'zap' ? 'thunder'
      : res.toolKind === 'smack' ? 'slipper'
      : 'coffee'
    );
    // 血条清零：先砸地（crash），180ms 后补一记呜咽 —— 先砸再哭，才像被打崩。
    // 用 justDowned（血量从 >0 掉到 0 的那一下）而不是 crashed：
    // crashed 是「当前 0 血」的状态，对着已经倒地的角色连点会一直哭。
    if (res.justDowned) {
      SFX.play('crash');
      SFX.play('whimper', 0.18);
    }

    /* ---- 震屏 ---- */
    if (S.settings.shake && !isHeal) {
      const amp = res.crashed ? 15 : Math.min(11, 4 + res.combo * 1.6);
      const dur = res.crashed ? 440 : 240;
      /*
       * ⚠ 只震 #roster（抽打靶场），绝不能震 #app。
       *
       * 根因（用户报的「抽打时 AI 监视器界面和框出现轻微偏移」）：
       * 内嵌的 AI 网页是主进程的 WebContentsView —— 一层**原生视图**，
       * 它不参与 DOM 的 transform 合成。震屏动画 transform 的是 #app，
       * DOM 侧的 embed-tabs / embed-tools / vframe 边框会跟着位移几像素，
       * 而压在 .embed-hole 上的原生网页纹丝不动 —— 两者一错位，
       * 看起来就是「画面和框偏了」。240ms 动画结束后又弹回去，来回晃。
       *
       * 角色框本身就是抽打发生的地方，震它打击反馈一点不少；
       * 预览墙区域则全程纹丝不动，网页和框永远严丝合缝。
       * effects.js 里那套 shake 是 canvas 绘制时的 ctx 平移，
       * 只动粒子层不碰布局，与这里互不相干。
       */
      $('#roster').animate(
        [
          { transform: 'translate(0,0)' },
          { transform: `translate(${-amp}px, ${amp * 0.4}px)` },
          { transform: `translate(${amp * 0.85}px, ${-amp * 0.35}px)` },
          { transform: `translate(${-amp * 0.4}px, ${amp * 0.2}px)` },
          { transform: 'translate(0,0)' }
        ],
        { duration: dur, easing: 'cubic-bezier(.36,.07,.19,.97)' }
      );
    }

    /* ---- 台词 ---- */
    const line = Voices.speak(char, {
      combo: res.combo,
      hp: res.hp,
      maxHp: res.maxHp,
      stress: res.stress,
      busy: c_hasTasks(c, appId),
      heal: isHeal,
      revive: res.crashed
    });
    showBubble(appId, line, isHeal ? 'heal' : res.crashed ? 'strike' : '');

    lastHitAt[appId] = Date.now();
  }

  function c_hasTasks(c, appId) {
    const cur = S && S.chars.find((x) => x.id === appId);
    return cur ? (cur.activeTasks || []).length > 0 : false;
  }

  function dmgOf(t) {
    const x = TOOLS_DEF.find((y) => y.id === t);
    return x ? Math.abs(x.dmg) : 10;
  }

  /**
   * 伤害飘字文本（2026-10-12 武器伤害 ÷10 后需要）：
   * 单次伤害会小于 1（水枪 0.5、皮鞭 1.2），直接取整会全变成「1」看不出差别，
   * 所以小于 1 的保留一位小数，≥1 的正常取整。
   */
  function dmgText(delta) {
    const v = Math.abs(Number(delta) || 0);
    if (v <= 0) return '1';
    return v < 1 ? v.toFixed(1) : String(Math.round(v));
  }

  let bubbles = [];
  function showBubble(appId, text, cls) {
    clearBubble(appId);
    const el = document.createElement('div');
    el.className = 'bubble ' + (cls || '');
    el.dataset.app = appId;
    const c = byId(appId);
    el.innerHTML = `<div class="who">${c ? nameOfChar(c) : ''} 说：</div>${text}`;
    $('#bubbles').appendChild(el);

    const box = document.querySelector(`.rbox[data-app="${appId}"]`);
    let x = innerWidth / 2 - 120,
      y = innerHeight / 2;
    if (box) {
      const r = box.getBoundingClientRect();
      x = Math.max(12, Math.min(innerWidth - 270, r.left + r.width / 2 - 90));
      // 角色框在顶部，台词气泡往下弹才不会盖住角色框头部
      y = Math.max(70, r.bottom + 8);
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    requestAnimationFrame(() => el.classList.add('show'));

    const rec = { appId, el, until: Date.now() + 4200 };
    bubbles.push(rec);
  }

  function clearBubble(appId) {
    bubbles = bubbles.filter((b) => {
      if (b.appId === appId) {
        b.el.remove();
        return false;
      }
      return true;
    });
  }

  function syncBubbles() {
    const now = Date.now();
    bubbles = bubbles.filter((b) => {
      if (now > b.until) {
        b.el.classList.remove('show');
        const el = b.el;
        setTimeout(() => el.remove(), 300);
        return false;
      }
      return true;
    });
    bubbles.forEach((b) => {
      const box = document.querySelector(`.rbox[data-app="${b.appId}"]`);
      if (!box) return;
      const r = box.getBoundingClientRect();
      b.el.style.left = Math.max(12, Math.min(innerWidth - 270, r.left + r.width / 2 - 90)) + 'px';
      b.el.style.top = Math.max(70, r.bottom + 8) + 'px';
    });
  }

  /* ---------------- 检视面板（整栏已删除） ---------------- */

  const LVL_CLS = { info: '', warn: 'l-warn', error: 'l-error', success: 'l-ok' };

  /*
   * 2026-10-13：「观察产物」入口已按用户要求删除（角色框头部按钮 +
   * 观察弹窗及其三个辅助函数一并移除）。
   * watch 通道本身保留：历史会话恢复（applySnapshots / session:event）
   * 与渲染层的 watch 状态变量仍依赖它们，删除会破坏旧存档。
   */

  /*
   * 任务列表 / 运行日志的渲染函数已随右侧检视面板一起删除。
   * 任务的入口现在只剩 ⌘N。
   */

  /* ---------------- 顶部统计 / 侧栏 ---------------- */

  /**
   * 左侧「角色展示」侧栏。
   *
   * 2026-10-11 改版：不再罗列全部角色 —— 没接入的角色摆在这里
   * 只是十二行重复的「未读中」噪声。现在只同步呈现**已连接**的角色
   * （与顶部角色框同一份 connectedIds，接入一个出现一个），
   * 每行升级为一张小展示卡：形象头像 + 名字 + 通道/状态 + 角色色血条。
   *
   * 侧栏本体可通过左上角 ‹ 收成细条（body.side-collapsed），
   * 收起状态不参与渲染，只是 CSS 把列宽压到 34px。
   */
  function renderMini(s) {
    const box = $('#miniList');
    if (!box) return;
    const empty = $('#sideEmpty');

    // 与 renderRoster 同一份「已接入」口径：按会话存活顺序
    const liveIds = Object.keys(sessions).filter((sid) => sessions[sid].status !== 'closed');
    const connectedIds = [];
    liveIds.forEach((sid) => {
      const id = sessions[sid].appId;
      if (id && !connectedIds.includes(id)) connectedIds.push(id);
    });
    const list = connectedIds
      .map((id) => s.chars.find((c) => c.id === id))
      .filter(Boolean);

    if (empty) empty.style.display = list.length ? 'none' : '';
    if (!list.length) {
      box.innerHTML = '';
      return;
    }

    box.innerHTML = list
      .map((c) => {
        const hpPct = hpPctOf(c.hp, c.maxHp);
        const hp = hpPct.shown;
        const art = hpArt(hpPct.exact);
        const sid = sessionOf(c.id);
        const sess = sid ? sessions[sid] : null;
        const chLabel =
          sess && sess.channel === 'embed' ? '网页'
          : sess && sess.channel === 'cli' ? '命令行'
          : sess && sess.channel === 'watch' ? '观察'
          : sess && sess.channel === 'capture' ? '应用'
          : '在线';
        return `<div class="mini ${selected === c.id ? 'sel' : ''} ${art === 'down' ? 'down' : ''}" data-app="${c.id}"
            style="--hp-c:${hpColor(c.id)}" title="${escapeAttr(nameOfChar(c) + ' · 点它单独看 · 右键改属性')}">
          ${Jelly.avatar(skinOf(c.id), { size: 34, state: art })}
          <div class="mini-meta">
            <div class="mini-name">${escapeHtml(nameOfChar(c))}</div>
            <div class="mini-sub">${escapeHtml(chLabel)} · ${escapeHtml(STATE_LABEL[art] || art)}</div>
            <div class="bar hp"><i class="${hpCls(hp, art)}" style="width:${hp}%"></i></div>
          </div>
          <div class="mini-state">${hp}%</div>
        </div>`;
      })
      .join('');
    $$('#miniList .mini').forEach((el) => {
      const id = el.dataset.app;
      el.onclick = () => {
        selected = selected === id ? null : id;
        render(S);
      };
      // 与顶部角色框一致：右键 = 属性（改名 / 换形象）
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openCharProps(id);
      });
    });
  }

  function renderTicker(s) {
    const items = s.feed
      .slice(0, 14)
      .map((f) => `<span class="ticker-item ${f.kind || ''}">${timeAgo(f.t)} · ${escapeHtml(f.text)}</span>`)
      .join('');
    const t = $('#ticker');
    if (t) t.innerHTML = items + items;
  }

  /* ---------------- 弹窗 ---------------- */

  function toast(msg, ms) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 2200);
  }

  /**
   * 弹窗容器。
   *
   * WebContentsView 是独立于 DOM 的原生视图层，z-index / backdrop-filter 都压不住它。
   * 所以弹窗一打开就必须把所有内嵌视图收成 0 尺寸，否则已接入的 AI 界面
   * 会直接浮在弹窗上面（用户报的「添加应用的时候把 AI 界面一起显示出来了」）。
   *
   * 用 MutationObserver 盯住 #modalRoot：只要还有任何 .mask 就保持收起，
   * 最后一个弹窗关掉才恢复。这样无论是点「好」、点遮罩空白、按 ESC，
   * 还是代码里 wrap.remove()，恢复时机都不用各自处理。
   */
  let modalWatch = null;
  function syncEmbedSuppression() {
    const root = $('#modalRoot');
    if (!root) return;
    const open = !!root.querySelector('.mask');
    if (open === embedsSuppressed) return;
    embedsSuppressed = open;
    // 立刻收/放，别等下一次布局变化才生效
    syncEmbedBounds();
    // 放回来时窗口尺寸、卡片宽度都可能与收起前不同，补两次同步确保贴合
    if (!open) {
      setTimeout(syncEmbedBounds, 80);
      setTimeout(syncEmbedBounds, 300);
    }
  }

  function modal(html) {
    const wrap = document.createElement('div');
    wrap.className = 'mask';
    wrap.innerHTML = `<div class="modal">${html}</div>`;
    const root = $('#modalRoot');
    root.appendChild(wrap);

    if (!modalWatch && root) {
      modalWatch = new MutationObserver(() => syncEmbedSuppression());
      modalWatch.observe(root, { childList: true });
    }
    // 插入时就同步一次（首个弹窗走这里）
    setTimeout(syncEmbedSuppression, 0);

    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) wrap.remove();
    });
    return wrap;
  }

  let newKind = 'image';
  let newPriority = 1;

  function openNewTask(appId) {
    // 用运行时列表取默认角色，否则用户只加了自定义应用、
    // 又没手选角色时，这里会指向一个静态内置角色去。
    const pre = appId || selected || allChars()[0].id;
    const wrap = modal(`
      <h3>给它派点活</h3>
      <p class="desc">任务会进入队列并自动开工；真实适配会自动识别执行模式。</p>

      <div class="field">
        <label>派给谁</label>
        <div class="row3" id="picker">
          ${allChars().map((c) => `<div class="opt ${c.id === pre ? 'sel' : ''}" data-id="${c.id}">${escapeHtml(nameOf(c.id))}<br><span style="font-size:10px;opacity:.7">${escapeHtml(c.app)}</span></div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>项目名称</label>
        <input type="text" id="nTitle" placeholder="例如：618 主视觉 KV" />
      </div>

      <div class="row2">
        <div class="field">
          <label>产出类型</label>
          <div class="row3" id="kinds">
            ${Object.keys(KIND_LABEL).map((k) => `<div class="opt ${k === newKind ? 'sel' : ''}" data-k="${k}">${KIND_LABEL[k]}</div>`).join('')}
          </div>
        </div>
        <div class="field">
          <label>优先级</label>
          <div class="row3" id="prios">
            <div class="opt ${newPriority === 0 ? 'sel' : ''}" data-p="0">佛系</div>
            <div class="opt ${newPriority === 1 ? 'sel' : ''}" data-p="1">正常</div>
            <div class="opt ${newPriority === 2 ? 'sel' : ''}" data-p="2">加急</div>
          </div>
        </div>
      </div>

      <div class="field">
        <label>提示词 / 需求描述</label>
        <textarea id="nPrompt" placeholder="写得越具体，它翻车的时候你越好骂"></textarea>
      </div>

      <div class="field">
        <label>执行方式</label>
        <select id="nMode"><option value="sim">模拟引擎（先看看效果）</option><option value="real">真实执行（走已接入的适配层）</option></select>
      </div>

      <div class="modal-foot">
        <button class="btn" id="nCancel">再想想</button>
        <button class="btn primary" id="nOk">派活！</button>
      </div>
    `);

    let who = pre;

    wrap.querySelector('#picker').onclick = (e) => {
      const o = e.target.closest('.opt');
      if (!o) return;
      who = o.dataset.id;
      wrap.querySelectorAll('#picker .opt').forEach((x) => x.classList.toggle('sel', x === o));
    };
    wrap.querySelector('#kinds').onclick = (e) => {
      const o = e.target.closest('.opt');
      if (!o) return;
      newKind = o.dataset.k;
      wrap.querySelectorAll('#kinds .opt').forEach((x) => x.classList.toggle('sel', x === o));
    };
    wrap.querySelector('#prios').onclick = (e) => {
      const o = e.target.closest('.opt');
      if (!o) return;
      newPriority = +o.dataset.p;
      wrap.querySelectorAll('#prios .opt').forEach((x) => x.classList.toggle('sel', x === o));
    };
    wrap.querySelector('#nCancel').onclick = () => wrap.remove();
    wrap.querySelector('#nOk').onclick = async () => {
      const title = wrap.querySelector('#nTitle').value.trim();
      const prompt = wrap.querySelector('#nPrompt').value.trim();
      const mode = wrap.querySelector('#nMode').value;
      const r = await window.api.createTask({ appId: who, title, prompt, kind: newKind, priority: newPriority, mode });
      if (r && r.ok) {
        if (mode === 'real' && !title) toast('提示：真实模式下最好写清楚需求');
        toast('已派给 ' + nameOf(who) + '，它跑不掉了');
        SFX.play('ding');
        wrap.remove();
        S = await window.api.boot();
        render(S);
      } else {
        toast('派单失败：' + (r && r.msg));
      }
    };
    setTimeout(() => wrap.querySelector('#nTitle').focus(), 60);
  }

  function openDex() {
    // 走运行时列表：用户添加的本地应用也要能查得到、看得到、移得掉
    const chars = allChars();
    const customCount = chars.filter((c) => c.custom).length;

    const wrap = modal(`
      <h3>角色图鉴</h3>
      <p class="desc">全部 ${chars.length} 位打工仔${customCount ? '（含 ' + customCount + ' 个你添加的本地应用）' : ''}。想改内置 AI 的形象？打开 <code>src/shared/characters.js</code> 改配色和配件即可。</p>
      <div class="dex-grid">
        ${chars.map((c) => {
          const rt = S ? S.chars.find((x) => x.id === c.id) : null;
          // 图鉴里的形象同样按血条档位显示（未接入 = 满血开心）
          const rtpct = rt && rt.maxHp ? (rt.hp / rt.maxHp) * 100 : 100;
          return `<div class="dex-card">
            ${Jelly.render(c, { size: 118, state: hpArt(rtpct), key: 'dex-' + c.id })}
            <div class="nm">${escapeHtml(nameOf(c.id))}</div>
            <div class="tt">${escapeHtml(c.app)} · ${escapeHtml(c.title || '')}</div>
            <div class="tg">${escapeHtml(c.tag || '')}</div>
            <div class="traits">${(c.traits || []).map((t) => `<i>${escapeHtml(t)}</i>`).join('')}</div>
            <div class="tg" style="margin-top:8px">已完成 ${rt ? rt.tasksDone || 0 : 0} 单 · 挨打 ${rt ? rt.hits || 0 : 0} 次 · 崩溃 ${rt ? rt.crashes || 0 : 0} 次</div>
            ${
              c.custom
                ? `<div class="dex-acts"><button class="btn" data-rm="${escapeAttr(c.id)}">移除</button></div>`
                : ''
            }
          </div>`;
        }).join('')}
      </div>
      <div class="modal-foot"><button class="btn primary" id="dexClose">关掉</button></div>
    `);

    // 自定义角色可移除；内置的不给按钮（engine 那边也会拦一道）
    wrap.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        const r = await window.api.removeCustomApp(b.dataset.rm);
        if (r && r.ok) {
          toast('已移除');
          wrap.remove();
        } else {
          toast('移除失败：' + ((r && r.msg) || '未知原因'));
        }
      };
    });
    wrap.querySelector('#dexClose').onclick = () => wrap.remove();
    return wrap;
  }

  /**
   * 重命名某个 AI。
   *
   * 名字优先级：用户自定义 > 本机 .app 真实显示名 > 系统默认名。
   * 这里改的是最高优先级那一层；传空串即可撤销自定义、回到系统默认名。
   *
   * 为什么需要它：同一个软件在不同系统 / 语言下显示名不同
   * （Claude 在英文系统叫 Claude，中文系统可能叫克劳德），
   * 用户在自己的机器上看到的才是他熟悉的叫法。
   */
  /**
   * 角色属性弹窗：改名 + 换形象，一个窗口全搞定。
   *
   * 入口：右键顶部角色框 / 右键左侧展示卡 / 预览卡上的 ✎。
   * 之前「双击改名」在频繁抽打时极易误触（连点节奏本来就是两连击），
   * 右键在抽打场景下永远不会被左键连点带出来。
   *
   * 形象选择是**本地暂存**：点格子只高亮，点「保存」才一次性提交
   * 名字和形象 —— 半路反悔点取消，什么都不会变。
   */
  function openCharProps(appId) {
    const def = byId(appId);
    if (!def) return;
    const cur = skinOf(appId);
    const curId = cur ? cur.id : appId;
    const sysDefault = def.app || appId;
    const curName = nameOf(appId);
    let pickId = curId; // 暂存的形象选择；等于默认 id = 用回自己的形象

    const cells = CHARACTERS.map((cd) => {
      const on = cd.id === curId;
      const isDefault = cd.id === appId;
      return `<button class="skin-cell ${on ? 'on' : ''}" data-pick="${escapeAttr(cd.id)}"
          title="${escapeAttr((cd.app || cd.id) + (isDefault ? ' · 默认形象' : ''))}">
        <span class="skin-fig">${Jelly.render(cd, { size: 74, state: 'joy', key: 'pp-' + cd.id })}</span>
        <span class="skin-name">${escapeHtml(cd.app || cd.id)}${isDefault ? ' · 默认' : ''}</span>
      </button>`;
    }).join('');

    const wrap = modal(`
      <h3>角色属性 · ${escapeHtml(curName)}</h3>
      <div class="field">
        <label>显示名称</label>
        <input type="text" id="ppName" maxlength="24" value="${escapeAttr(curName !== sysDefault ? curName : '')}" placeholder="${escapeAttr(sysDefault)}" />
        <div class="hint" id="ppHint">留空则恢复系统默认名：${escapeHtml(sysDefault)}</div>
      </div>
      <div class="field">
        <label>角色形象</label>
        <div class="skin-grid">${cells}</div>
        <div class="hint">只换皮不改台词和脾气；血条颜色也会跟着新形象走。</div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="ppCancel">取消</button>
        <button class="btn primary" id="ppOk">保存</button>
      </div>
    `);

    const input = wrap.querySelector('#ppName');
    const hint = wrap.querySelector('#ppHint');
    input.addEventListener('input', () => {
      const v = input.value.trim();
      hint.textContent = v ? '将显示为：' + v : '留空则恢复系统默认名：' + sysDefault;
    });

    wrap.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => {
        pickId = b.dataset.pick;
        wrap.querySelectorAll('[data-pick]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });

    wrap.querySelector('#ppCancel').onclick = () => wrap.remove();
    wrap.querySelector('#ppOk').onclick = async () => {
      const name = input.value.trim();
      let changed = false;
      if (window.api.setName) {
        const r = await window.api.setName(appId, name);
        if (r && r.ok) changed = true;
      }
      if (pickId !== curId && window.api.setSkin) {
        const r = await window.api.setSkin(appId, pickId === appId ? '' : pickId);
        if (!r || !r.ok) toast((r && r.msg) || '换形象失败');
        else changed = true;
      }
      wrap.remove();
      if (changed) {
        S = await window.api.boot();
        render(S);
        if (S) renderWall(S);
        toast(name ? '已保存：' + name : '已保存');
      }
    };
    setTimeout(() => input.focus(), 60);
  }

  /*
   * openRename 已并入 openCharProps（2026-10-11）：
   * 双击改名在频繁抽打时极易误触，入口统一改为右键 → 属性，
   * 名字和形象在同一个弹窗里一次改完。单独的改名弹窗随之删除。
   */

  function openSettings() {
    const s = S.settings;
    const wrap = modal(`
      <h3>设置</h3>
      <p class="desc">所有设置保存在本机，不上传任何数据。</p>

      <div class="set-block">
        <h4>偏好</h4>
        <div class="set-row"><span class="lb">夜间模式</span><button class="switch ${s.theme === 'night' ? 'on' : ''}" id="swTheme"></button></div>
        <div class="set-row"><span class="lb">音效</span><button class="switch ${s.sfx !== false ? 'on' : ''}" id="swSfx"></button></div>
        <div class="set-row"><span class="lb">打击震屏</span><button class="switch ${s.shake !== false ? 'on' : ''}" id="swShake"></button></div>
        <div class="set-row"><span class="lb">自动开工</span><button class="switch ${s.autoRun !== false ? 'on' : ''}" id="swAuto"></button></div>
      </div>

      <div class="set-block">
        <h4>并发</h4>
        <div class="set-row"><span class="lb">全局并行</span><input type="text" id="maxG" value="${s.maxConcurrent}"></div>
        <div class="set-row"><span class="lb">单角色并行</span><input type="text" id="maxA" value="${s.maxPerApp}"></div>
        <div class="hint">排队任务会在有空位时自动补位。</div>
      </div>

      <div class="set-block">
        <h4>数据</h4>
        <div class="hint">存档位置：应用数据目录下的 state.json</div>
        <div class="set-row">
          <button class="act" id="btnReveal">打开存档目录</button>
          <button class="act danger" id="btnReset">重置全部数据</button>
        </div>
      </div>

      <div class="set-block">
        <h4>连接</h4>
        <div class="hint">
          已接入的 AI 记在存档里，完全退出再打开时会自动恢复。<br>
          ⌘R / 刷新只是重画界面，不断开。想清掉所有连接，用下面这个 —— 这是唯一的入口。
        </div>
        <div class="set-row">
          <button class="act danger" id="btnClearAll">清空所有连接</button>
        </div>
        <div class="hint" id="clearAllState">当前已接入：0 个</div>
      </div>

      <div class="set-block">
        <h4>关于</h4>
        <div class="set-row"><span class="lb">当前版本</span><span class="ver-num" id="verNow">…</span></div>
        <div class="set-row">
          <button class="act" id="btnUpdate">检查更新</button>
        </div>
        <div class="hint">这是浏览器演示版：没有更新与安装概念，刷新页面即回到初始状态。</div>
      </div>

      <div class="modal-foot">
        <button class="btn" id="btnClearDone">清理已完成</button>
        <button class="btn primary" id="setDone">完成</button>
      </div>
    `);

    wrap.querySelector('#setDone').onclick = () => wrap.remove();

    // 关于：显示版本号 + 检查更新
    const verEl = wrap.querySelector('#verNow');
    if (verEl) {
      try {
        window.api.appVersion().then((v) => (verEl.textContent = 'v' + v));
      } catch (e) { /* 取不到就留空，顶栏反正有 */ }
    }
    const btnUpdate = wrap.querySelector('#btnUpdate');
    if (btnUpdate) {
      // 拍板方案（2026-10-25）：不做版本比对，点了直接打开下载页。
      btnUpdate.onclick = async () => {
        btnUpdate.disabled = true;
        try {
          await window.api.updateCheck();
          toast('已打开下载页：下载安装新版本，已购买的解锁不会丢');
        } catch (e) {
          toast('打不开下载页，请稍后再试');
        }
        btnUpdate.disabled = false;
      };
    }

    // 「清空所有画面」：原来这个语义挂在 ⌘R 上（刷新 = 清空），
    // 刷新本来就该只是重画界面，所以拆到这里来。
    const clearState = wrap.querySelector('#clearAllState');
    const countLive = () =>
      Object.values(sessions).filter((s) => s.status !== 'closed').length;
    const paintCount = () => {
      if (clearState) clearState.textContent = `当前已接入：${countLive()} 个`;
    };
    paintCount();

    const btnClearAll = wrap.querySelector('#btnClearAll');
    if (btnClearAll) {
      btnClearAll.onclick = async () => {
        const n = countLive();
        if (!n) return toast('当前没有已接入的 AI');
        if (!confirm(`确定清空 ${n} 个已接入的 AI 吗？\n它们的会话会被真正断开（⌘R 刷新不会）。`)) return;
        btnClearAll.disabled = true;
        btnClearAll.textContent = '清空中…';
        try {
          if (window.api.sessionDisconnectAll) await window.api.sessionDisconnectAll();
          else {
            for (const sid of Object.keys(sessions)) await window.api.sessionDisconnect(sid);
          }
        } catch (e) {
          toast('清空失败：' + (e && e.message));
        }
        sessions = {};
        connected.clear();
        activeSid = null;
        watchSid = null;
        watchTarget = null;
        selected = null;
        if (S) render(S);
        paintCount();
        btnClearAll.disabled = false;
        btnClearAll.textContent = '清空所有连接';
        toast('已清空 ' + n + ' 个连接');
      };
    }

    const sw = (id, key, getter) => {
      const el = wrap.querySelector(id);
      el.onclick = async () => {
        const v = getter === undefined ? el.classList.contains('on') : getter;
        await window.api.setSetting(key, !v);
        el.classList.toggle('on', !v);
        S.settings[key] = !v;
        applySettings();
        if (key === 'sfx') SFX.setEnabled(!v);
      };
    };
    sw('#swTheme', 'theme', S.settings.theme === 'night');
    sw('#swSfx', 'sfx', S.settings.sfx !== false);
    sw('#swShake', 'shake', S.settings.shake !== false);
    sw('#swAuto', 'autoRun', S.settings.autoRun !== false);

    wrap.querySelector('#maxG').addEventListener('change', async (e) => {
      await window.api.setSetting('maxConcurrent', Math.max(1, Math.min(12, +e.target.value || 5)));
    });
    wrap.querySelector('#maxA').addEventListener('change', async (e) => {
      await window.api.setSetting('maxPerApp', Math.max(1, Math.min(6, +e.target.value || 2)));
    });
    wrap.querySelector('#btnReveal').onclick = () => window.api.reveal();
    wrap.querySelector('#btnReset').onclick = async () => {
      await window.api.reset();
      S = await window.api.boot();
      render(S);
      wrap.remove();
      toast('世界已重置');
    };
    wrap.querySelector('#btnClearDone').onclick = async () => {
      await window.api.clearFinished();
      S = await window.api.boot();
      render(S);
    };
    return wrap;
  }

  /* ---------------- 全局绑定 ---------------- */

  /*
   * 认证中心。
   *
   * ⚠⚠ 为什么必须做这个，而不是继续在卡片角落各放一个按钮：
   *
   *   这个项目里「一直卡住」的很大一部分，其实是**权限**没配齐，
   *   而权限有几个互相独立的项（屏幕录制 / 辅助功能 / 输入监控），
   *   它们分散在系统设置的不同面板，界面上的入口也散落在两张卡的不同角落。
   *   用户勾了其中一个，界面上看不出还缺哪个 ——
   *   于是「反复勾选还是不行」，而且每次排查都从零开始。
   *
   *   这里的每一项状态都来自**本 App 进程内的实测**
   *   （CGPreflightPostEventAccess / CGPreflightScreenCaptureAccess），
   *   不是「截张图试试、看报错里有没有 permission 字样」那种猜法。
   *   猜法最恶劣的地方在于：报错文案一变，界面就会显示「一切正常」。
   */
  async function openAuthCenter() {
    /*
     * 兜底保护（2026-10-10）。
     *
     * 这个弹窗的数据源是 window.api.permissionAll()，它已经随桌面捕获方案
     * 从 preload 里移除了。当前没有任何入口会调到这个函数（顶栏 🔑 已下线），
     * 但只要有人把它接回去 —— 或者将来某条路径又走到这里 ——
     * 直呼 permissionAll 会抛 TypeError，弹窗连画都画不出来，用户只看到「点了没反应」。
     * 所以这里先给一句人话。
     */
    if (!window.api || typeof window.api.permissionAll !== 'function') {
      return toast('认证中心已随桌面捕获方案下线：现在只用内嵌网页，不需要系统权限');
    }

    const wrap = modal(`
      <h3>认证中心</h3>
      <p class="desc">下面每一项都是本程序刚刚在你机器上实测的结果。缺哪一项，点它右边的按钮直接跳到对应的系统设置页。</p>
      <div id="authList" class="auth-list"><div class="auth-loading">正在检测…</div></div>
      <div class="modal-foot">
        <button class="btn" id="authRecheck">重新检测</button>
        <button class="btn primary" id="authDone">好</button>
      </div>
      <p class="auth-note">说明：macOS 上「屏幕录制」「辅助功能」是两个互相独立的权限，只勾其中一个是不够的。改完系统设置后，需要<b>完全退出本程序再重新打开</b>才会生效。</p>
    `);

    const listEl = wrap.querySelector('#authList');

    const itemBtn = (it) => {
      if (it.granted) return '';
      if (it.key === 'screen') {
        return `
          <div class="auth-acts">
            <button class="btn primary" data-auth-go="screen">一键请求屏幕录制权限</button>
            <button class="btn" data-auth-open="screen">打开设置页</button>
          </div>`;
      }
      if (it.key === 'postEvents' || it.key === 'trusted') {
        return `
          <div class="auth-acts">
            <button class="btn primary" data-auth-open="ax">打开辅助功能设置</button>
          </div>`;
      }
      return '';
    };

    const draw = (snap) => {
      const items = (snap && snap.items) || [];
      if (!items.length) {
        listEl.innerHTML = '<div class="auth-loading">没有可检测的项（或该平台不支持）。</div>';
        return;
      }
      listEl.innerHTML = items.map((it) => `
        <div class="auth-row ${it.granted ? 'ok' : 'bad'}">
          <span class="auth-dot"></span>
          <div class="auth-body">
            <div class="auth-title">${escapeHtml(it.title)}
              <span class="auth-state">${it.granted ? '已授权' : '未授权'}</span>
            </div>
            <div class="auth-detail">${escapeHtml(it.detail || '')}</div>
            ${itemBtn(it)}
          </div>
        </div>`).join('');

      // 逐行绑定：跳设置页 / 主动请求授权
      listEl.querySelectorAll('[data-auth-open]').forEach((b) => {
        b.onclick = () => {
          const k = b.dataset.authOpen;
          const p = k === 'screen'
            ? window.api.openScreenRecordingSettings()
            : window.api.openAxSettings();
          p.then((r) => {
            if (r && r.ok) toast('已打开系统设置，勾选「网页窗口合集」后请完全退出重开', 4200);
            else toast('打不开设置页，请手动到 系统设置 → 隐私与安全性', 4200);
          }).catch(() => toast('打不开设置页'));
        };
      });
      listEl.querySelectorAll('[data-auth-go]').forEach((b) => {
        b.onclick = () => {
          // 先请求（会让系统把本 App 登记进列表 / 弹出引导），再跳设置页
          window.api.requestScreenCapture().catch(() => null).then(() => {
            return window.api.openScreenRecordingSettings();
          }).then(() => {
            toast('已请求「屏幕录制」权限并打开设置页，勾选后完全退出重开', 4600);
            setTimeout(refresh, 900);
          }).catch(() => toast('请求失败，请手动到系统设置里勾选', 4200));
        };
      });
    };

    const refresh = () => {
      if (!document.body.contains(wrap)) return;
      listEl.innerHTML = '<div class="auth-loading">正在检测…</div>';
      window.api.permissionAll()
        .then(async (snap) => {
          draw(snap);
          await refreshAxState();
          // 授权回来后自动恢复已有桌面会话，不要求用户反复断开重连。
          if (snap && snap.items && snap.items.some((it) => it.key === 'screen' && it.granted)) {
            await Promise.all(Object.keys(sessions).map(async (sid) => {
              const s = sessions[sid];
              if (!s || s.channel !== 'capture' || !s.readonly) return;
              try { await window.api.captureRecapture(sid); } catch (e) {}
            }));
          }
        })
        .catch(() => {
          listEl.innerHTML = '<div class="auth-loading">检测失败。</div>';
        });
    };

    wrap.querySelector('#authRecheck').onclick = refresh;
    wrap.querySelector('#authDone').onclick = () => wrap.remove();
    refresh();
  }

  function bindGlobal() {
    // 右上角「＋」已随顶栏删除（2026-10-17）：接入入口 = 角色板自带的 ＋ 模块。
    // 按钮不在了就跳过，别让启动期绑定抛错。
    const btnNew = $('#btn-new');
    if (btnNew) btnNew.onclick = () => openConnectPicker();
    $('#btn-setting').onclick = () => openSettings();
    // 认证中心入口已下线（2026-10-10）：产品改为只内嵌网页版，
    // 不再依赖屏幕录制 / 辅助功能，而它依赖的 window.api.permissionAll
    // 也已从 preload 移除。按钮与绑定必须一起删 —— 只删一个就会得到
    // 「按钮在但点了抛 TypeError」或「按钮没了但代码还在找它」。
    // 旧方案完整备份：.backups/current-capture-control-20261010
    // 从系统设置切回 App 时，立即复查真实权限，清掉旧的未授权缓存。
    window.addEventListener('focus', () => { refreshAxState(); });
    /*
     * 2026-10-24：「扫描本机应用」按钮下线，绑定一起删。
     *   - #btn-scan（侧栏底部圆钮）：本机 .app 扫描拿不到任何可用通道，
     *     点了永远空结果 —— 按钮、onclick、refreshInstalled、
     *     installed / installedAt 以及只依赖 installed 的旧接入选择器
     *     整套一起清掉。
     *   - #btn-strip-scan：只存在于 h5 静态演示页，桌面版没有这个元素，
     *     绑定本来就是空转（元素取不到），一并删。
     *   - doScan() 必须保留：连接选择器 / 通道探测仍靠它刷 scan.best。
     */
    // 2026-10-13：角色框头部的「观察产物 / 派活 / 重新扫描」三个按钮已按用户要求删除；
    // 派活仍可 ⌘N 呼出。

    // 监视器拖动排序：长按卡片标签条的空白处即可拎起整张卡
    bindWallDrag();

    // 侧栏「视图筛选」已删除，这里原本是 .nav-item 的绑定。
    // 左栏现在是「角色展示」卡，选中逻辑统一在 renderMini() 里点 .mini 处理。

    // 侧栏收起 / 展开：只切 body class，布局交给 CSS；
    // 收起后内嵌视图的位置会变，必须补一次坐标同步，
    // 否则原生网页还压在旧位置上（布局变了视图不动）。
    const sideToggle = $('#sideToggle');
    if (sideToggle) {
      sideToggle.onclick = () => {
        const collapsed = document.body.classList.toggle('side-collapsed');
        sideToggle.textContent = collapsed ? '›' : '‹';
        syncEmbedBounds();
        setTimeout(syncEmbedBounds, 80);
        setTimeout(syncEmbedBounds, 300);
      };
    }

    /* ---- 内嵌视图的位置跟随 ----
     * WebContentsView 是独立于页面的一层原生视图，位置不会自己跟着布局走。
     * 滚动预览墙时必须重新报坐标，而且必须**每帧都报**：
     * 它不受 DOM overflow 裁剪，一旦位置落后就会糊在滚动区外的
     * 道具栏 / 状态栏上（用户看到的「AI 窗口突出整个窗口」）。
     */
    const scroller = $('#wallScroll');
    if (scroller) {
      scroller.addEventListener('scroll', syncOnFrame, { passive: true });
    }
    window.addEventListener('resize', scheduleSync);
    // Ctrl +/- 改变页面缩放时，CSS 尺寸不变但物理像素变了，同样要重报
    window.addEventListener('beforeunload', () => {
      Object.values(sessions).forEach((s) => {
        if (s.embedKey) window.api.embedBounds(s.embedKey, { x: 0, y: 0, width: 0, height: 0 });
      });
    });

    document.addEventListener('keydown', (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        return openNewTask();
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= TOOLS_DEF.length) setTool(TOOLS_DEF[idx - 1].id);
      if (e.key === 'Escape') {
        selected = null;
        $$('#modalRoot .mask').forEach((m) => m.remove());
        render(S);
      }
      if (e.key === ' ') {
        e.preventDefault();
        // 空格随机抽打：只在**已接入**的角色里挑，
        // 没接入的打下去只是动画，命中不了任何真实对象。
        const busy = S.chars.filter(
          (c) => connected.has(c.id) && c.activeTasks && c.activeTasks.length
        );
        const pool = busy.length ? busy : S.chars.filter((c) => connected.has(c.id));
        if (pool.length) doHit(pool[Math.floor(Math.random() * pool.length)].id, null);
        else toast('还没接入任何 AI，先点右上角 ＋ 接入');
      }
    });
  }

  async function doLaunch(appId) {
    const r = await window.api.launch(appId);
    if (r) toast((r.ok ? '🚀 ' : '⚠️ ') + r.msg);
  }

  boot().catch((e) => {
    console.error(e);
    document.body.innerHTML = `<div style="padding:40px;font-family:system-ui">启动失败：${e && e.message}<br><pre>${e && e.stack}</pre></div>`;
  });
})();
