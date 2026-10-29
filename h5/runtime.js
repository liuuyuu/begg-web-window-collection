/**
 * H5 运行时 · 浏览器版主进程替身
 *
 * 目标：不装 Electron、不写任何文件、不碰用户电脑，
 * 在浏览器里跑**真实的** engine.js（不是模拟数据），验证完整交互。
 *
 * 做法：把 Node 的 CommonJS 约定在浏览器里最小实现一遍，
 * engine.js 只需要 process.platform + require，适配成本极低。
 */
(function (global) {
  'use strict';

  /* ---------- 极简 CommonJS 加载器 ---------- */

  const modules = {};

  function define(name, factory) {
    modules[name] = factory;
  }

  function require(name) {
    if (!modules[name]) throw new Error('模块未定义: ' + name);
    // 每次都重新调用 factory：engine.js 在本脚本之后才加载，
    // 缓存首次调用的 undefined 会导致 "Engine is not a constructor"
    const val = modules[name]();
    if (!val) throw new Error('模块尚未就绪（加载顺序问题）: ' + name);
    return val;
  }

  // engine.js 只需要这两个
  const process = { platform: 'browser', env: {} };

  /* ---------- 内存存储 ---------- */

  function memStore() {
    let data = null;
    return {
      read: () => data,
      write: (d) => {
        data = d;
      },
      update: (fn) => {
        data = fn(data);
        return data;
      },
      clear: () => {
        data = null;
      }
    };
  }

  /* ---------- 假连接探测（H5 里用预设清单） ---------- */

  // 浏览器无法扫描本机，所以用一份「常见安装」清单，
  // 让连接面板有内容可看、真假一目了然。真实扫描由 Electron 版负责。
  const MOCK_SCAN = {
    results: {
      kimi: [
        { kind: 'app', name: 'Kimi 桌面应用', label: '桌面应用', ok: true, appName: 'Kimi', version: '3.2.15', inspectable: true, appPath: '~/Applications/Kimi.app' },
        { kind: 'url', name: 'Kimi 网页版', label: '网页', ok: true, url: 'https://www.kimi.com' }
      ],
      doubao: [
        { kind: 'app', name: '豆包桌面应用', label: '桌面应用', ok: true, appName: 'Doubao', version: '2.31.4', inspectable: false, appPath: '/Applications/Doubao.app' },
        { kind: 'url', name: '豆包网页版', label: '网页', ok: true, url: 'https://www.doubao.com' }
      ],
      chatgpt: [
        { kind: 'app', name: 'ChatGPT 桌面应用', label: '桌面应用', ok: true, appName: 'ChatGPT', version: '26.1002.52244', inspectable: false, appPath: '/Applications/ChatGPT.app' },
        { kind: 'url', name: 'ChatGPT 网页版', label: '网页', ok: true, url: 'https://chatgpt.com' }
      ],
      workbuddy: [{ kind: 'app', name: 'WorkBuddy 桌面应用', label: '桌面应用', ok: true, appName: 'WorkBuddy', version: '5.7.6', inspectable: true, appPath: '/Applications/WorkBuddy.app' }],
      codex: [{ kind: 'cli', name: 'Codex CLI', label: '命令行', ok: true, binPath: '~/.local/bin/codex', version: '（本机未安装）' }],
      claude: [{ kind: 'cli', name: 'Claude Code CLI', label: '命令行', ok: true, binPath: '~/.local/bin/claude', version: '（本机未安装）' }],
      gemini: [{ kind: 'url', name: 'Gemini 网页版', label: '网页', ok: true, url: 'https://gemini.google.com' }],
      cursor: [{ kind: 'url', name: 'Cursor 网页版', label: '网页', ok: true, url: 'https://cursor.com' }],
      grok: [{ kind: 'url', name: 'Grok 网页版', label: '网页', ok: true, url: 'https://grok.com' }],
      suno: [{ kind: 'url', name: 'Suno 网页版', label: '网页', ok: true, url: 'https://suno.com' }],
      sora: [{ kind: 'url', name: 'Sora 网页版', label: '网页', ok: true, url: 'https://sora.com' }],
      sd: [{ kind: 'url', name: 'Stable Diffusion WebUI', label: '本地服务', ok: true, url: 'http://127.0.0.1:7860', local: true }]
    }
  };

  /* ---------- 假会话：模拟一个会流式输出的 AI ---------- */

  const FAKE_TALK = {
    cli: [
      '正在读取项目结构…',
      '读取到 12 个文件，主入口 src/main/index.js',
      '思考：这里需要极简配色…',
      '写入 styles.css',
      '校验对比度：AA ✓',
      '完成，已生成 1 个文件'
    ],
    app: [
      '正在理解你的问题…',
      '已读取当前页面内容',
      '思考中…',
      '生成回答草稿',
      '完成'
    ],
    url: ['已在浏览器中打开该页面（H5 版无法读取其内部过程）']
  };

  let seq = 0;
  const sessions = {};

  function emit(evt) {
    const h = global.__sessionHandler;
    if (h) h(evt);
  }

  function pushLine(sid, appId, level, text) {
    emit({ type: 'session:line', sid, appId, line: { t: Date.now(), level, text } });
  }

  /**
   * 造一份「像真的观察器输出」的观测结果。
   * 与 src/main/watcher.js 的 inferProgress 逻辑对齐：
   * 文件越多、近期改动越多，进度越高；静默时缓慢向收尾爬。
   */
  function makeFakeObservation(dir, seed) {
    const files = 12 + (seed % 9);
    const changed = [];
    const n = Math.min(4, seed % 5);
    for (let i = 0; i < n; i++) {
      changed.push({
        rel: `src/module_${(seed % 6) + i}.js`,
        kind: i % 2 ? 'edit' : 'new',
        size: 1200 + i * 300,
        delta: 120 + i * 40
      });
    }
    const quietMs = seed % 4 === 0 ? 22000 : (seed % 4) * 5000;
    const progress = Math.min(96, 18 + ((seed * 7) % 66) + (quietMs > 15000 ? 5 : 0));
    const reasons = [`${files} 个文件在 10 分钟内被改`];
    if (n) reasons.push(`本轮新增/修改 ${n} 个文件`);
    if (quietMs > 12000) reasons.push(`已静默 ${Math.round(quietMs / 1000)} 秒（可能在跑测试/构建）`);
    return {
      dir,
      progress,
      reasons,
      changed,
      totalFiles: files,
      totalBytes: files * 4096,
      quietMs,
      elapsed: (seed + 1) * 2000
    };
  }

  async function fakeConnect(p) {
    const ch = p.channel || MOCK_SCAN.results[p.appId]?.[0];
    const sid = 's' + Date.now().toString(36) + (seq++).toString(36);
    const kind = (ch && ch.kind) || 'url';
    const s = {
      sid,
      appId: p.appId,
      channel: kind,
      name: (ch && ch.name) || '未命名通道',
      status: 'connecting',
      lines: [],
      readonly: kind === 'url' || kind === 'watch',
      loop: !!p.loop,
      startedAt: Date.now(),
      timer: null
    };
    sessions[sid] = s;
    pushLine(sid, p.appId, 'info', '正在连接：' + s.name);

    // 产物观察：像真的观察器那样持续推送，而不是播一遍固定台词就结束
    if (kind === 'watch') {
      s.readonly = true;
      s.status = 'live';
      pushLine(sid, p.appId, 'success', '正在观察产物：' + ((ch && ch.dir) || ''));
      emit({ type: 'session:state', sid, appId: p.appId, status: 'live' });

      let step = 0;
      s.timer = setInterval(() => {
        step++;
        const obs = makeFakeObservation((ch && ch.dir) || 'demo', step);
        pushLine(sid, p.appId, 'info',
          `[产物观察] ${obs.progress}%  ${obs.reasons.join(' / ')}`);
        if (obs.changed.length) {
          const list = obs.changed
            .map((c) => {
              const tag = c.kind === 'new' ? '新增' : '修改';
              const d = c.kind === 'edit' && c.delta != null
                ? ` (${c.delta >= 0 ? '+' : ''}${c.delta}B)` : '';
              return `  ${tag}  ${c.rel}${d}`;
            })
            .join('\n');
          pushLine(sid, p.appId, obs.changed.length >= 3 ? 'ok' : 'info', list);
        }
        emit({
          type: 'session:watch',
          sid,
          appId: p.appId,
          progress: obs.progress,
          reasons: obs.reasons,
          changed: obs.changed,
          totalFiles: obs.totalFiles,
          quietMs: obs.quietMs
        });
      }, 2000);

      return {
        sid, appId: p.appId, channel: kind, name: s.name,
        status: 'live', readonly: true, lines: []
      };
    }

    // 逐行吐出模拟输出；预置演示会话播完隔几秒再来一轮，
    // 让来访者任何时候打开页面都有「AI 正在干活」的画面可看。
    const script = FAKE_TALK[kind] || FAKE_TALK.url;
    let i = 0;
    function talkRound() {
      i = 0;
      s.timer = setInterval(() => {
        if (i >= script.length) {
          clearInterval(s.timer);
          s.status = 'live';
          pushLine(sid, p.appId, 'success', '— 本轮输出结束，休息片刻 —');
          emit({ type: 'session:state', sid, appId: p.appId, status: 'live' });
          if (s.loop) s.timer = setTimeout(talkRound, 4500);
          return;
        }
        pushLine(sid, p.appId, 'info', script[i++]);
      }, 620);
    }
    talkRound();

    setTimeout(() => {
      s.status = 'live';
      emit({ type: 'session:state', sid, appId: p.appId, status: 'live' });
    }, 400);

    return {
      sid,
      appId: p.appId,
      channel: kind,
      name: s.name,
      status: 'connecting',
      readonly: s.readonly,
      lines: []
    };
  }

  function fakeWrite(sid, text) {
    const s = sessions[sid];
    if (!s) return { ok: false, msg: '会话不存在' };
    if (s.channel === 'url') return { ok: false, msg: '该通道只读（H5 演示模式）' };
    pushLine(sid, s.appId, 'info', '❯ ' + text);
    setTimeout(() => {
      pushLine(sid, s.appId, 'info', `收到，正在处理：${text}`);
      setTimeout(() => pushLine(sid, s.appId, 'success', '完成（H5 演示回复）'), 500);
    }, 300);
    return { ok: true };
  }

  function fakeDisconnect(sid) {
    const s = sessions[sid];
    // s.timer 既可能是 interval（输出流）也可能是 timeout（循环重启），
    // 两种都要清，否则断开后还会偷偷往已删会话推日志
    if (s && s.timer) { clearInterval(s.timer); clearTimeout(s.timer); }
    delete sessions[sid];
    emit({ type: 'session:closed', sid, appId: s && s.appId });
    return { ok: true };
  }

  /* ---------- 预置演示会话 ----------
   * 2026-10-24 桌面版把「扫描本机应用」整套下线，界面口径改成「只显示已接入」。
   * 浏览器版接不了真实应用，所以页面加载时就预连几个演示通道：
   * 来访者一进来就能看到「有 AI 在干活、可以抽打」的完整画面，
   * 不用先研究接入流程。 */
  const PRESET = [
    { appId: 'claude',   loop: true },
    { appId: 'chatgpt',  loop: true },
    { appId: 'doubao',   loop: true },
    { appId: 'kimi',     loop: true, channel: { kind: 'watch', dir: '/Users/you/WorkBuddy/你的项目', name: '产物观察 · 你的项目' } }
  ];
  PRESET.forEach(function (p) {
    // 同步预连：app.js 启动恢复（sessionSnapshots/sessionRestore）不等人，
    // 错峰延迟会让它读到空快照、界面落回「还没接入任何 AI」的空态
    fakeConnect(p).catch(function () {});
  });

  /* 把当前会话整理成桌面版 sessionSnapshots 的同形快照，供启动恢复 */
  function snapList() {
    return Object.values(sessions).map((s) => ({
      sid: s.sid,
      appId: s.appId,
      channel: s.channel,
      name: s.name,
      status: s.status,
      readonly: !!s.readonly,
      degraded: false,
      embedKey: s.embedKey || '',
      embedUrl: s.embedUrl || '',
      needsLogin: false,
      startedAt: s.startedAt,
      lines: s.lines.slice(-400)
    }));
  }

  /* ---------- 暴露 window.api（与 Electron preload 同形） ---------- */

  let engine = null;

  function bootEngine() {
    if (engine) return engine;
    const { Engine } = require('main/engine.js');
    engine = new Engine(memStore());
    engine.onChange((snap) => emit({ type: 'state:tick', snap }));
    engine.start();
    return engine;
  }

  global.api = {
    boot: async () => bootEngine().snapshot(),
    tools: async () => require('main/engine.js').TOOLS,

    createTask: async (p) => bootEngine().createTask(p),
    startTask: async (id) => engine.startTask(id),
    pauseTask: async (id) => engine.pauseTask(id),
    cancelTask: async (id) => engine.cancelTask(id),
    retryTask: async (id) => engine.retryTask(id),
    rushTask: async (id) => engine.rushTask(id),
    clearFinished: async () => engine.clearFinished(),
    taskLog: async (id) => engine.taskLog(id),

    hit: async (appId, tool) => bootEngine().hit(appId, tool),

    setSetting: async (k, v) => bootEngine().setSetting(k, v),
    setApp: async (id, cfg) => bootEngine().setAppConfig(id, cfg),
    probeApp: async (cfg) => ({ ok: true, msg: 'H5 演示模式：不校验真实连接' }),
    reset: async () => bootEngine().resetAll(),

    launch: async (appId) => ({ ok: true, msg: 'H5 演示模式：无法唤起本地应用' }),
    dispatch: async () => ({ ok: true, msg: 'H5 演示模式' }),
    pickFile: async () => null,
    reveal: async () => null,

    scanLocal: async () => {
      const r = { scannedAt: Date.now(), results: JSON.parse(JSON.stringify(MOCK_SCAN.results)) };
      r.best = {};
      const order = { cli: 0, app: 1, url: 2 };
      Object.keys(r.results).forEach((id) => {
        const list = r.results[id].slice().sort((a, b) => order[a.kind] - order[b.kind]);
        const b = list[0];
        r.best[id] = b ? { kind: b.kind, name: b.name, label: b.label, interactive: b.kind !== 'url' } : null;
      });
      return r;
    },

    // 浏览器里扫不到本机应用，这里用一份示意清单，
    // 让顶部「本机 AI 应用」那条带在演示时也有内容可看。
    listInstalled: async () => {
      const demo = [
        { name: 'ChatGPT', version: '26.1002.52244', electron: false, appPath: '(H5 演示)', agentId: 'chatgpt', agentName: 'ChatGPT 桌面应用' },
        { name: '豆包', version: '2.31.4', electron: false, appPath: '(H5 演示)', agentId: 'doubao', agentName: '豆包桌面应用' },
        { name: 'Kimi', version: '3.2.15', electron: true, appPath: '(H5 演示)', agentId: 'kimi', agentName: 'Kimi 桌面应用' },
        { name: 'WorkBuddy', version: '5.7.6', electron: true, appPath: '(H5 演示)', agentId: 'workbuddy', agentName: 'WorkBuddy 桌面应用' },
        { name: 'Codex', version: '', electron: false, appPath: '(H5 演示)', agentId: 'codex', agentName: 'Codex 桌面应用' }
      ];
      return { apps: demo, total: demo.length, scannedAt: Date.now() };
    },

    /* ---- 产物观察 ----
     * 浏览器里读不到真实文件系统，这里返回一份演示用的观察结果，
     * 让「按产物推断进度」这条通道在 H5 里也能看到界面效果。
     * 签名与 src/main/preload.js 保持一致。                        */
    watchCandidates: async () => {
      return {
        dirs: [
          { dir: '/Users/you/WorkBuddy/你的项目', label: '你的项目', hint: '最近改动过' },
          { dir: '/Users/you/.codex/sessions', label: 'Codex 会话记录', hint: 'AI 任务的直接产物' }
        ]
      };
    },
    watchPeek: async (dir) => makeFakeObservation(dir, Math.floor(Date.now() / 3000)),

    sessionConnect: fakeConnect,
    // 签名必须与 src/main/preload.js 完全一致：(sid, text)
    sessionWrite: async (sid, text) => fakeWrite(sid, text),
    sessionDispatch: async (sid, prompt) => fakeWrite(sid, prompt),
    sessionDisconnect: async (sid) => fakeDisconnect(sid),
    // 设置里的「清空所有画面」
    sessionDisconnectAll: async () => {
      Object.keys(sessions).forEach((sid) => fakeDisconnect(sid));
      return { ok: true };
    },
    sessionList: async () => Object.values(sessions).map((s) => ({ sid: s.sid, appId: s.appId, status: s.status, name: s.name, lines: s.lines.length })),
    // 刷新后恢复界面用：完整快照，字段与 Electron 版 sessionSnapshots 一致
    sessionSnapshots: async () => snapList(),
    // 桌面版的「后台逐个重连」在浏览器里不存在：预置演示会话在页面加载时
    // 就已经建好，这里回同一份快照，让 app.js 的恢复流程原样走通
    sessionRestore: async () => snapList(),

    /* ---- 演示版专属 ----
     * 浏览器版没有付费墙：全部道具直接解锁，让来访者完整玩一遍。
     * 授权文件、兑换码与支付链路只存在于桌面版，不在本仓库。         */
    licenseState: async () => ({ unlocked: true, ownedTools: [] }),
    appVersion: async () => '0.1.0-demo',
    updateCheck: async () => false,

    onSession: (cb) => {
      global.__sessionHandler = cb;
    },
    onTick: (cb) => {
      global.__tickHandler = cb;
      // engine 的 onChange 已统一走 emit，这里桥接一次
      const e = bootEngine();
      e.onChange((snap) => cb(snap));
    }
  };

  global.__h5 = { define, require, process };
})(window);