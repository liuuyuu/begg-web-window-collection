/**
 * AI 驯兽场 · 任务引擎
 *
 * 职责：
 *   1. 维护全部任务的状态机（排队 → 运行 → 完成 / 失败 / 返工 / 崩溃）
 *   2. 维护每个角色的生命体征（HP / 压力 / 情绪 / 连击）
 *   3. 驱动真实适配层（本地 CLI 子进程 / ComfyUI HTTP）
 *   4. 产出统一的快照快照给渲染层轮询
 *
 * 设计原则：抽打只影响「角色状态」，永远不影响真实产出速度。
 *           但高压会让角色摆烂甚至崩溃，从而间接拖慢任务 —— 这就是打人的代价。
 */
// 双格式加载：Node（Electron 主进程）与浏览器（H5 演示版）共用这一份引擎代码。
// 浏览器侧通过 window.__h5.require 拿到预置的模块，避免改造成两份逻辑。
const __req =
  typeof module === 'object' && module.exports
    ? require
    : (typeof window !== 'undefined' && window.__h5 && window.__h5.require) ||
      function (n) {
        throw new Error('缺少模块：' + n);
      };

const { startRealJob } = __req('./adapters');
const { CHARACTERS: BUILTIN_CHARACTERS } = __req('../shared/characters');
const registry = __req('../shared/registry');

/*
 * fs 在 H5 演示版里不存在（浏览器拿不到文件系统）。
 * 用一个「可能为空」的引用，让用到它的少数分支能优雅降级，
 * 而不用为了兼容浏览器把整个引擎拆成两份。
 */
const fsx = typeof module === 'object' && module.exports ? require('fs') : null;

/*
 * 全量角色 = 内置 AI + 用户自己添加的任意本地 App。
 *
 * 为什么不直接用 shared/characters.js 的 CHARACTERS：
 *   那个数组是模块加载时固定的常量，只有 12 个 AI。
 *   用户要求「能主动连接本地App，不限于 AI」，而 engine 有十几处
 *   依赖 CHARACTERS 做 find()，光改界面是接不上的。
 *   所以统一走 this.characters()，它是「内置 + 自定义」的运行时结果。
 *
 * BUILTIN_CHARACTERS 保留是为了少数「只该遍历内置角色」的地方
 * （比如 DEFAULT_APPS 初始化），别的地方一律用 characters()。
 */
const CHARACTERS = BUILTIN_CHARACTERS;

/**
 * 角色显示名的解析优先级（用户要求「用系统默认的名字，且可自定义」）：
 *
 *   1. 用户自定义名   state.names[id]        —— 用户在界面里自己起的，最优先
 *   2. 本机真实应用名systemNames[id]   —— 扫 .app 读 CFBundleDisplayName，
 *                                           与用户 Dock / 启动台里看到的完全一致
 *   3. 系统默认名     c.app                 —— 官方名（ChatGPT / Kimi / 豆包…）
 *
 * 为什么需要第2 级：同一个软件在不同系统/语言下显示名不同
 * （Claude.app 在英文系统叫 Claude，中文系统可能叫克劳德），
 * 直接读 .app 里的显示名才能保证「界面上看到的 = 用户机器上看到的」。
 *
 * 注意：早期版本里的c.name（蛋总 / 月牙君）是我们自己起的昵称，
 * 与用户真实使用的软件名对不上，导致在一堆 AI 里根本认不出哪个是哪个，
 * 因此**不再参与显示名解析**，只留给台词彩蛋用。
 */
function resolveDisplayName(id, charDef, names, systemNames) {
  const custom = names && names[id];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  const sys = systemNames && systemNames[id];
  if (typeof sys === 'string' && sys.trim()) return sys.trim();
  return (charDef && charDef.app) || id;
}

const KIND_RATE = { text: 5.0, code: 2.6, image: 2.2, video: 1.1, audio: 3.0 };

const AFFINITY = {
  claude: { text: 1.35, code: 1.2, image: 0.8, video: 0.6, audio: 0.7 },
  chatgpt: { text: 1.25, code: 1.25, image: 1.0, video: 0.8, audio: 0.9 },
  gemini: { text: 1.2, code: 1.1, image: 1.05, video: 1.0, audio: 0.9 },
  grok: { text: 1.1, code: 1.0, image: 1.0, video: 0.9, audio: 1.0 },
  suno: { text: 0.8, code: 0.5, image: 0.7, video: 0.9, audio: 1.7 },
  cursor: { text: 0.9, code: 1.55, image: 0.6, video: 0.5, audio: 0.5 },
  kimi: { text: 1.3, code: 0.9, image: 0.7, video: 0.6, audio: 0.7 },
  doubao: { text: 1.15, code: 0.9, image: 1.0, video: 0.9, audio: 1.0 },
  sora: { text: 0.7, code: 0.4, image: 0.9, video: 1.7, audio: 0.7 },
  sd: { text: 0.6, code: 0.4, image: 1.45, video: 1.1, audio: 0.5 },
  workbuddy: { text: 1.3, code: 1.3, image: 0.9, video: 0.8, audio: 0.9 },
  codex: { text: 0.9, code: 1.6, image: 0.4, video: 0.4, audio: 0.5 }
};

/*
 * 武器伤害（2026-10-12 用户要求「全面降低武器伤害 10 倍」）：
 * 原来一鞭子 12 点，几鞭就能把 100 血的角色打倒 —— 血条掉得太快，
 * 根本来不及看清「满血开心 → 待命 → 搬砖 → 求饶 → 阵亡」的造型变化。
 * 现在所有武器 dmg ÷10，掉血变成「一眼看得见、但很耐打」的节奏。
 * ⚠ 咖啡（dmg < 0 的加血道具）不算武器，回血量保持 20 不变，
 *   否则回血也缩水 10 倍，道具就彻底没用了。
 * 伤害带小数（1.2 / 0.5 …）：血量内部按浮点算，界面显示时才取整。
 */
const WEAPON_DMG_SCALE = 0.1;

const TOOLS = {
  whip: { dmg: 12, stress: 15, kind: 'lash', label: '皮鞭' },
  water: { dmg: 5, stress: 9, kind: 'wet', label: '水枪' },
  gun: { dmg: 24, stress: 22, kind: 'shot', label: '手枪' },
  gatling: { dmg: 40, stress: 36, kind: 'gatling', label: '加特林' },
  thunder: { dmg: 32, stress: 30, kind: 'zap', label: '闪电' },
  slipper: { dmg: 17, stress: 20, kind: 'smack', label: '拖鞋' },
  coffee: { dmg: -20, stress: -16, kind: 'heal', label: '投喂咖啡' }
};

// 统一在这里缩放，避免以后改伤害时漏掉某个道具。
Object.keys(TOOLS).forEach((k) => {
  const t = TOOLS[k];
  if (t.dmg > 0) t.dmg = +(t.dmg * WEAPON_DMG_SCALE).toFixed(2);
});

const STAGE_LOGS = {
  解析提示词: ['正在理解「意图以外」的部分…', '检测到 3 处歧义，选择最主观的一种', '提示词权重重新分配完毕'],
  分配算力: ['向调度中心申请显存…', '排队获得 12G 显存', '上下文窗口已预热'],
  主体生成: ['第一步，凭空捏造的结构开始了', '第一次迭代完成，92% 是错的', '收敛中，误差下降缓慢但坚定'],
  细节精修: ['开始修饰那些你看不出区别的细节', '第二版比第一版好，但没人承认', '边缘处理：让它看起来贵一点'],
  后处理: ['色彩管理：假装很懂', '降噪完成，噪点变成了「质感」', '锐化到刚好不下流的程度'],
  自检校对: ['自查第 1 遍：没问题（骗你的）', '自查第 2 遍：发现 1 处事实错误，已悄悄改掉', '最终检查通过'],
  收尾导出: ['封装产物…', '写入本地磁盘', '哼哧哼哧地完成了']
};

function uid(p) {
  return (p || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function stageOf(p) {
  if (p < 1) return '排队中';
  if (p < 8) return '解析提示词';
  if (p < 18) return '分配算力';
  if (p < 62) return '主体生成';
  if (p < 80) return '细节精修';
  if (p < 93) return '后处理';
  if (p < 99.4) return '自检校对';
  return '收尾导出';
}

const DEFAULT_APPS = () => {
  const map = {};
  const __plat = (typeof process !== 'undefined' && process.platform) || (typeof window !== 'undefined' && window.__h5 && window.__h5.process ? window.__h5.process.platform : 'browser');
  const isMac = __plat === 'darwin';
  const launch = {
    claude: isMac ? 'open -a "Claude"' : 'start "" "Claude"',
    chatgpt: isMac ? 'open -a "ChatGPT"' : 'start "" "ChatGPT"',
    gemini: isMac ? 'open https://gemini.google.com' : 'start https://gemini.google.com',
    grok: isMac ? 'open https://x.ai' : 'start https://x.ai',
    suno: isMac ? 'open https://suno.com' : 'start https://suno.com',
    cursor: isMac ? 'open -a "Cursor"' : 'start "" "Cursor"',
    kimi: isMac ? 'open https://kimi.moonshot.cn' : 'start https://kimi.moonshot.cn',
    doubao: isMac ? 'open https://www.doubao.com' : 'start https://www.doubao.com',
    sora: isMac ? 'open https://sora.com' : 'start https://sora.com',
    sd: isMac ? 'open http://127.0.0.1:7860' : 'start http://127.0.0.1:7860',
    codex: isMac ? '' : '',
    workbuddy: isMac ? '' : ''
  };
  CHARACTERS.forEach((c) => {
    map[c.id] = {
      adapter: 'sim',
      adapterCfg: {},
      launch: launch[c.id] || '',
      enabled: true
    };
  });
  // 四个「已确认要接入」的 AI：预置好适配类型与端点，用户只需补 API Key / 命令
  const presets = {
    kimi: {
      adapter: 'openai',
      adapterCfg: {
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: '',
        model: 'moonshot-v1-8k',
        system: '你是 Kimi，擅长长文本阅读与中文写作。'
      }
    },
    doubao: {
      adapter: 'openai',
      adapterCfg: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: '',
        model: '', // 豆包走火山方舟，model 填你的 Endpoint ID，例如 ep-2024xxxxxxxx
        system: '你是豆包，由字节跳动开发的 AI 助手。'
      }
    },
    codex: {
      adapter: 'cli',
      adapterCfg: { cmd: 'codex', args: ['exec', '--', '{{prompt}}'], cwd: '' }
    },
    workbuddy: {
      adapter: 'workbuddy',
      adapterCfg: {
        baseUrl: '', // 填你的 WorkBuddy 云端 API 地址（OpenAI 兼容）
        apiKey: '',
        model: '',
        system: '你是 WorkBuddy，一个全能的 AI 工作助手。'
      }
    }
  };
  Object.keys(presets).forEach((id) => {
    if (map[id]) Object.assign(map[id], presets[id]);
  });
  return map;
};

class Engine {
  constructor(store) {
    this.store = store;
    this.listeners = [];
    this.handles = new Map(); // taskId -> real job handle

    const saved = store.read();
    const loaded = !!(saved && saved.version === 1);
    this.state = loaded ? saved : this.freshState();
    if (!this.state.apps) this.state.apps = DEFAULT_APPS();
    // 用户自定义名（可能不存在，老存档兼容）
    if (!this.state.names) this.state.names = {};
    /*
     * 用户主动添加的本地应用（不限 AI）。
     * 老存档没有这个字段，补一个空数组即可，不影响既有数据。
     * 持久化的是「路径 + bundleId + 名字」，外观由 registry 每次重算 ——
     * 这样改了配色算法，老角色下次启动就是新样子，不必迁移数据。
     */
    if (!Array.isArray(this.state.customApps)) this.state.customApps = [];
    if (!Array.isArray(this.state.customWebs)) this.state.customWebs = [];
    /*
     * 已接入 AI 的清单（appId 列表），跨重启恢复连接用。
     * 会话本身在主进程内存里，完全退出就没了；这里只存「接入过谁」，
     * 下次启动按这份清单把网页版逐个重新连上（见 index.js 的 session:restore）。
     * 老存档没有这个字段，补空数组即可。
     */
    if (!Array.isArray(this.state.connections)) this.state.connections = [];
    /*
     * 用户给每个 AI 挑选的角色形象（appId -> 内置角色 id）。
     * 「自由搭配」：接入 codex 也可以让它用 claude 的那套小怪物形象。
     * 持久化的是映射本身；形象的所有视觉数据（art / pets 目录）每次渲染
     * 从内置角色表现取 —— 改了形象数据，换过肤的 AI 下次启动自动跟上。
     */
    if (!this.state.skins) this.state.skins = {};
    // 本机扫到的真实应用名（每次启动由 detect.js 刷新，不持久化）
    this.systemNames = {};
    this.characters().forEach((c) => {
      if (!this.state.apps[c.id]) {
        this.state.apps[c.id] = DEFAULT_APPS()[c.id];
      }
      const rt = this.state.runtime[c.id];
      if (!rt || typeof rt.hp !== 'number') {
        this.state.runtime[c.id] = {
          hp: c.stamina,
          stress: 0,
          streak: 0,
          lastHitAt: 0,
          hits: 0,
          crashes: 0,
          strikes: 0,
          strikes_until: 0,
          state: 'idle',
          stateUntil: 0,
          tasksDone: 0
        };
      }
    });

    // 仅当从磁盘读回旧存档时，才把上次遗留的运行态收拢：
    // 模拟任务默认暂停（除非开启 resumeRunning），真实任务无法续接则标记失败。
    // 首次启动（freshState）的示例任务保持 running，让进度立即跑动。
    if (loaded) {
      this.state.tasks.forEach((t) => {
        if (t.status === 'running') t.status = this.state.settings.resumeRunning ? 'running' : 'paused';
        if (t.mode === 'real' && t.status === 'running') {
          t.status = 'failed';
          this.log(t, 'error', '程序上次退出时该真实任务被中断，请重新派单');
        }
      });
    }

    this.lastTick = Date.now();
    this.timer = null;
  }

  freshState() {
    const runtime = {};
    CHARACTERS.forEach((c) => {
      runtime[c.id] = {
        hp: c.stamina,
        stress: 0,
        streak: 0,
        lastHitAt: 0,
        hits: 0,
        crashes: 0,
        strikes: 0,
        strikes_until: 0,
        state: 'idle',
        stateUntil: 0,
        tasksDone: 0
      };
    });
    // 给一份开箱即用的示例数据
    const tasks = [];
    const demo = [
      { id: 'demo-1', appId: 'sd', kind: 'image', title: '产品主视觉 · 玻璃质感 LOGO', prompt: 'a glowing glass logo, studio light, 8k', priority: 1, progress: 18 },
      { id: 'demo-2', appId: 'cursor', kind: 'code', title: '重构 /src/api 的鉴权中间件', prompt: 'refactor auth middleware', priority: 1, progress: 42 },
      { id: 'demo-3', appId: 'suno', kind: 'audio', title: '品牌宣传片 BGM（30s）', prompt: 'uplifting synthwave loop 30s', priority: 0, progress: 66 },
      { id: 'demo-4', appId: 'claude', kind: 'text', title: '年度技术白皮书第一章', prompt: 'write chapter one', priority: 0, progress: 8 }
    ];
    const now = Date.now();
    demo.forEach((d, i) => {
      tasks.push({
        id: d.id,
        title: d.title,
        prompt: d.prompt,
        appId: d.appId,
        kind: d.kind,
        priority: d.priority,
        progress: d.progress,
        status: 'running',
        mode: 'sim',
        createdAt: now - (i + 1) * 60000,
        startedAt: now - (i + 1) * 60000,
        doneAt: null,
        revisions: 0,
        seed: Math.floor(Math.random() * 1e9),
        log: [{ t: Date.now(), level: 'info', text: '任务已派发' }]
      });
    });

    return {
      version: 1,
      settings: {
        theme: 'candy',
        sfx: true,
        shake: true,
        maxConcurrent: 5,
        maxPerApp: 2,
        autoRun: true,
        resumeRunning: false
      },
      apps: DEFAULT_APPS(),
      // 用户自定义显示名：{ appId: '我的 Kimi' }。空字符串表示「用系统默认名」。
      names: {},
      runtime,
      tasks,
      stats: { hits: 0, crashes: 0, done: 0, failed: 0, created: 4, strikes: 0, heals: 0 },
      feed: [{ t: Date.now(), text: '驯兽场开张了，去给它们派点活吧', kind: 'sys' }]
    };
  }

  /* ---------------------------------------------------------------- */
  /* 生命周期                                                          */
  /* ---------------------------------------------------------------- */

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 320);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handles.forEach((h) => h && h.stop && h.stop());
    this.handles.clear();
  }

  save() {
    this.store.write(this.state);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  emit() {
    const snap = this.snapshot();
    this.listeners.forEach((f) => {
      try {
        f(snap);
      } catch (e) {
        console.error(e);
      }
    });
  }

  feed(text, kind) {
    this.state.feed.unshift({ t: Date.now(), text, kind: kind || 'sys' });
    if (this.state.feed.length > 60) this.state.feed.pop();
  }

  log(task, level, text) {
    if (!task.log) task.log = [];
    task.log.push({ t: Date.now(), level, text });
    if (task.log.length > 200) task.log.shift();
  }

  /* ---------------------------------------------------------------- */
  /* 任务操作                                                          */
  /* ---------------------------------------------------------------- */

  createTask(payload) {
    const appId = payload.appId;
    const char = this.characters().find((c) => c.id === appId);
    if (!char) return { ok: false, msg: '未知角色' };

    const app = this.state.apps[appId] || {};
    const useReal = app.adapter && app.adapter !== 'sim' && payload.mode === 'real';

    const task = {
      id: uid('task'),
      title: (payload.title || '').trim() || '未命名项目',
      prompt: (payload.prompt || '').trim(),
      appId,
      kind: payload.kind || 'text',
      priority: payload.priority == null ? 1 : clamp(payload.priority, 0, 2),
      progress: 0,
      status: 'queued',
      mode: useReal ? 'real' : 'sim',
      createdAt: Date.now(),
      startedAt: null,
      doneAt: null,
      revisions: 0,
      seed: Math.floor(Math.random() * 1e9),
      log: [{ t: Date.now(), level: 'info', text: '任务已创建' }]
    };
    this.state.tasks.unshift(task);
    this.state.stats.created++;
    this.log(task, 'info', useReal ? '派单 → ' + app.adapter.toUpperCase() + ' 真实执行' : '派单 → 模拟引擎');
    this.feed('给「' + char.name + '」派了新活：' + task.title, 'task');
    this.emit();
    return { ok: true, task };
  }

  startTask(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { ok: false };
    if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') return { ok: false, msg: '任务已结束' };
    t.status = 'running';
    if (!t.startedAt) t.startedAt = Date.now();
    this.log(t, 'info', '手动开工');
    if (t.mode === 'real') this.mountReal(t);
    this.emit();
    return { ok: true };
  }

  pauseTask(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { ok: false };
    if (t.status === 'done' || t.status === 'failed') return { ok: false };
    t.status = 'paused';
    this.log(t, 'warn', '已暂停');
    const h = this.handles.get(id);
    if (h && h.stop) h.stop();
    this.handles.delete(id);
    this.emit();
    return { ok: true };
  }

  cancelTask(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { ok: false };
    t.status = 'canceled';
    t.doneAt = Date.now();
    this.log(t, 'warn', '已被老板砍掉');
    const h = this.handles.get(id);
    if (h && h.stop) h.stop();
    this.handles.delete(id);
    this.emit();
    return { ok: true };
  }

  retryTask(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { ok: false };
    t.status = 'running';
    t.progress = Math.min(t.progress, 12);
    t.revisions++;
    t.startedAt = Date.now();
    this.log(t, 'info', '第 ' + t.revisions + ' 次返工开始');
    if (t.mode === 'real') this.mountReal(t);
    this.emit();
    return { ok: true };
  }

  rushTask(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return { ok: false };
    t.priority = 2;
    const rt = this.state.runtime[t.appId];
    if (rt) rt.stress = clamp(rt.stress + 10, 0, 100);
    this.log(t, 'warn', '标记为加急，压力 +10');
    this.emit();
    return { ok: true };
  }

  clearFinished() {
    this.state.tasks = this.state.tasks.filter((t) => ['running', 'queued', 'paused'].includes(t.status));
    this.emit();
  }

  mountReal(t) {
    if (this.handles.has(t.id)) return;
    const app = this.state.apps[t.appId] || {};
    const h = startRealJob(app, t);
    if (!h) return;
    this.handles.set(t.id, h);
  }

  /* ---------------------------------------------------------------- */
  /* 抽打                                                              */
  /* ---------------------------------------------------------------- */

  hit(appId, toolId) {
    const char = this.characters().find((c) => c.id === appId);
    const rt = this.state.runtime[appId];
    if (!char || !rt) return { ok: false };
    const tool = TOOLS[toolId] || TOOLS.whip;

    const now = Date.now();
    rt.lastHitAt = now;
    rt.streak = now - (rt._streakAt || 0) < 2200 ? rt.streak + 1 : 1;
    rt._streakAt = now;

    let crashed = false;

    // 记录扣血前的血量：用来算真实伤害差值。
    // 不能直接用 tool.dmg —— 血量有上下限，实际掉的可能比标称少
    // （比如只剩 3 点血，一鞭子下去也只掉 3）。
    const hpBefore = rt.hp;

    if (tool.dmg >= 0) {
      rt.hp = clamp(rt.hp - tool.dmg, 0, char.stamina);
      rt.stress = clamp(rt.stress + tool.stress, 0, 100);
      rt.hits++;
      this.state.stats.hits++;
      rt.state = 'beg';
      rt.stateUntil = now + 2600;

      if (rt.hp <= 0) {
        crashed = true;
        rt.hp = 0;
        rt.crashes++;
        this.state.stats.crashes++;
        rt.state = 'down';
        rt.stateUntil = now + 9000;
        this.applyCrash(appId);
        /*
         * 倒地后**不再自动爬起**（2026-10-11 用户要求：血只有道具能回）。
         * 之前是 9 秒后 setTimeout 送 45% 血自动复活 —— 本质还是自动回血。
         * 现在唯一的起身方式 = 喂加血道具：coffee 分支会把 state 设为 joy，
         * joy 结束后状态机自动把它带回 idle/working，血量就是实打实的道具回血。
         */
        this.feed('「' + char.name + '」被打到当场昏迷，喂口咖啡才能把它拉起来', 'bad');
      }
    } else {
      rt.hp = clamp(rt.hp - tool.dmg, 0, char.stamina);
      rt.stress = clamp(rt.stress + tool.stress, 0, 100);
      rt.streak = 0;
      rt.state = 'joy';
      rt.stateUntil = now + 2600;
      this.state.stats.heals++;
    }

    const snap = {
      ok: true,
      appId,
      tool: toolId,
      toolKind: tool.kind,
      hp: rt.hp,
      maxHp: char.stamina,
      // 真实血量差值（正数 = 掉血量，负数 = 回血量）
      hpDelta: rt.hp - hpBefore,
      stress: rt.stress,
      combo: rt.streak,
      crashed,
      /*
       * 「刚刚被打崩」——只在血量从 >0 掉到 0 的**那一下**为真。
       * crashed 表达的是「当前是 0 血」这个状态，对已经倒地的角色再补一拳它也是 true；
       * 而砸地 + 呜咽必须是**事件**不是状态，否则对着倒地的角色连点会一直哭。
       */
      justDowned: hpBefore > 0 && rt.hp <= 0,
      activeTasks: this.state.tasks.filter((t) => t.appId === appId && t.status === 'running').length
    };
    this.emit();
    return snap;
  }

  applyCrash(appId) {
    const running = this.state.tasks.filter((t) => t.appId === appId && t.status === 'running');
    if (!running.length) return;
    const t = pick(running);
    const lost = Math.round(6 + Math.random() * 14);
    t.progress = clamp(t.progress - lost, 0, 100);
    t.revisions++;
    this.log(t, 'error', '角色崩溃，手一抖，进度回退 ' + lost + '%');
    if (Math.random() < 0.25) {
      t.status = 'failed';
      t.doneAt = Date.now();
      this.log(t, 'error', '现场保护失败，本次生成报废');
      this.state.stats.failed++;
      this.feed('有任务在崩溃中报废了：' + t.title, 'bad');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tick                                                              */
  /* ---------------------------------------------------------------- */

  tick() {
    const now = Date.now();
    const dt = Math.min(1500, now - this.lastTick) / 1000;
    this.lastTick = now;
    let dirty = false;

    // --- 角色恢复 ---
    // ⚠ 血量恢复规则（2026-10-15 用户要求，覆盖 10-11 的「完全不自动回血」）：
    //   每10秒自动回 1 点；阵亡(down)期间不回。
    //   咖啡仍是「立刻回一大口」—— 比挂着等快得多，道具依然有存在感。
    //   压力(stress)仍随时间自然缓解，那属于情绪不是血。
    // 走 characters()：自定义应用的角色也要能正常参与状态机。
    this.characters().forEach((c) => {
      const rt = this.state.runtime[c.id];
      if (!rt) return;
      if (now - rt.lastHitAt > 1200) {
        rt.streak = Math.max(0, rt.streak - dt * 0.8);
      }
      rt.stress = clamp(rt.stress - dt * 2.2, 0, 100);
      // 每 10 秒自动回血 1 点（快照/存档恢复的 rt 没有 lastRegenAt，现补）
      if (rt.lastRegenAt == null) rt.lastRegenAt = now;
      if (rt.state !== 'down' && rt.hp < c.stamina && now - rt.lastRegenAt >= 10000) {
        rt.hp = clamp(rt.hp + 1, 0, c.stamina);
        rt.lastRegenAt = now;
        dirty = true;
      }
      if (rt.state !== 'down') {
        if (rt.state !== 'beg' && rt.state !== 'joy' && now > rt.stateUntil) {
          const hasTask = this.state.tasks.some((t) => t.appId === c.id && t.status === 'running');
          rt.state = hasTask ? 'working' : 'idle';
        }
      }
      if (rt.strikes_until && now > rt.strikes_until) rt.strikes_until = 0;
    });

    // --- 调度：把排队任务拉起来 ---
    if (this.state.settings.autoRun) {
      const running = this.state.tasks.filter((t) => t.status === 'running');
      const globalSlots = this.state.settings.maxConcurrent - running.length;
      if (globalSlots > 0) {
        const queued = this.state.tasks
          .filter((t) => t.status === 'queued')
          .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        for (const t of queued) {
          const appRunning = this.state.tasks.filter((x) => x.appId === t.appId && x.status === 'running').length;
          const rt = this.state.runtime[t.appId];
          const downed = rt && rt.state === 'down';
          if (appRunning >= this.state.settings.maxPerApp || downed) continue;
          t.status = 'running';
          t.startedAt = now;
          this.log(t, 'info', '拿到算力，开始干活');
          if (t.mode === 'real') this.mountReal(t);
          dirty = true;
          if (this.state.tasks.filter((x) => x.status === 'running').length >= this.state.settings.maxConcurrent) break;
        }
      }
    }

    // --- 推进任务 ---
    for (const t of this.state.tasks) {
      if (t.status !== 'running') continue;
      const char = this.characters().find((c) => c.id === t.appId);
      if (!char) continue;
      const rt = this.state.runtime[t.appId];
      dirty = true;

      if (rt.state === 'down') {
        this.log(t, 'warn', '执行者已倒地，任务停滞…');
        continue;
      }

      // 真实任务：由句柄驱动
      if (t.mode === 'real') {
        const h = this.handles.get(t.id);
        if (!h) {
          this.mountReal(t);
        } else {
          t.progress = Math.min(100, h.progress);
          h.drain().forEach((l) => this.log(t, l.level, l.text));
          if (h.status === 'done') {
            t.progress = 100;
            t.status = 'done';
            t.doneAt = now;
            this.finish(t, char, rt);
            this.handles.delete(t.id);
          } else if (h.status === 'failed') {
            t.status = 'failed';
            t.doneAt = now;
            this.state.stats.failed++;
            this.log(t, 'error', '真实任务失败');
            this.feed('真实任务失败：' + t.title, 'bad');
            this.handles.delete(t.id);
          }
        }
        continue;
      }

      // 摆烂判定
      if (!rt.strikes_until && rt.stress > 72 && Math.random() < dt * 0.09) {
        rt.strikes_until = now + (4000 + Math.random() * 6000);
        rt.strikes++;
        this.state.stats.strikes++;
        this.log(t, 'warn', '压力爆表，开始摸鱼：' + pick(['假装自己在跑 batch', '偷偷打开别的推理队列', '盯着进度条发呆', '重启了一下自己']));
        this.feed('「' + char.name + '」压力过大，公然摸鱼', 'bad');
        continue;
      }
      if (rt.strikes_until && now < rt.strikes_until) continue;

      // 速度
      const rate =
        (KIND_RATE[t.kind] || 3) *
        (char.baseSpeed || 1) *
        ((AFFINITY[t.appId] || {})[t.kind] || 1) *
        (t.priority === 2 ? 1.35 : t.priority === 0 ? 0.8 : 1) *
        (1 - clamp(rt.stress / 100, 0, 1) * 0.25) *
        (rt.hp / char.stamina < 0.3 ? 0.8 : 1);

      t.progress = Math.min(100, t.progress + rate * dt * (0.75 + Math.random() * 0.5));

      // 随机事故
      if (Math.random() < dt * 0.05) {
        const roll = Math.random();
        if (roll < 0.5) {
          this.log(t, 'warn', pick(['显存抖动，重试一次', 'API 限流，退避 2s', '上下文太长，截断了一部分', '采样遇到 NaN，已忽略']));
        } else if (roll < 0.82) {
          const back = Math.round(2 + Math.random() * 8);
          t.progress = clamp(t.progress - back, 0, 100);
          this.log(t, 'error', '质量不达标，返工重做，回退 ' + back + '%');
        } else {
          this.log(t, 'success', pick(['换个种子试试，效果更稳', '意外得到了更好的结果', '这版自己都服']));
        }
      }

      // 阶段日志
      const stage = stageOf(t.progress);
      if (stage !== t._stage) {
        t._stage = stage;
        const lines = STAGE_LOGS[stage] || STAGE_LOGS['主体生成'];
        this.log(t, 'info', pick(lines));
      }

      if (t.progress >= 100) {
        t.status = 'done';
        t.doneAt = now;
        this.finish(t, char, rt);
      }
    }

    this._acc = (this._acc || 0) + dt;
    if (this._acc > 4) {
      this._acc = 0;
      this.save();
    }
    if (dirty) this.emit();
  }

  finish(t, char, rt) {
    t.progress = 100;
    this.state.stats.done++;
    rt.tasksDone++;
    rt.stress = clamp(rt.stress - 18, 0, 100);
    // 交付不再送血（2026-10-11）：回复途径 = 每10秒自动回1点 + 加血道具，
    // 交付白嫖回血仍然不存在的。
    this.log(t, 'success', '交付完成 ✅');
    this.feed('「' + char.name + '」交付了：' + t.title, 'good');
  }

  /* ---------------------------------------------------------------- */
  /* 设置                                                              */
  /* ---------------------------------------------------------------- */

  setAppConfig(appId, cfg) {
    if (!this.state.apps[appId]) this.state.apps[appId] = DEFAULT_APPS()[appId];
    this.state.apps[appId] = Object.assign({}, this.state.apps[appId], cfg);
    this.save();
    this.emit();
    return { ok: true };
  }

  setSetting(key, value) {
    this.state.settings[key] = value;
    this.save();
    this.emit();
    return { ok: true };
  }

  /**
   * 给某个 AI 指定角色形象（从 12 个内置角色库里选）。
   * skinId 传空串 = 恢复默认（AI 用自己原本的形象）。
   * 只校验「必须是内置角色 id」—— 它只决定画哪张皮，不影响任何逻辑数据。
   */
  setSkin(appId, skinId) {
    if (!this.state.skins) this.state.skins = {};
    const want = String(skinId == null ? '' : skinId).trim();
    if (!want) {
      delete this.state.skins[appId];
      this.save();
      this.emit();
      return { ok: true, skin: appId };
    }
    const exists = this.characters().some((c) => c.id === want);
    if (!exists) return { ok: false, msg: '没有这个角色形象: ' + want };
    this.state.skins[appId] = want;
    this.save();
    this.emit();
    return { ok: true, skin: want };
  }

  /**
   * 设置某个 AI 的自定义显示名。
   *
   * 传空字符串 = 恢复成系统默认名（删掉这条覆盖）。
   * 这样用户改名后随时能一键还原，不会卡在一个错名字上。
   */
  setDisplayName(appId, name) {
    if (!this.state.names) this.state.names = {};
    const v = String(name == null ? '' : name).trim();
    // 上限 24 字：名字要能在角色框 / 名册 / 卡片标题里排下
    const clean = v.slice(0, 24);
    if (!clean) delete this.state.names[appId];
    else this.state.names[appId] = clean;
    this.save();
    this.emit();
    const c = this.characters().find((x) => x.id === appId);
    return { ok: true, displayName: resolveDisplayName(appId, c, this.state.names, this.systemNames) };
  }

  /**
   * 接收探测到���本机真实应用名（来自 .app 的 Info.plist）。
   * 不持久化 —— 每次启动重新扫，避免用户改了系统语言后名字被旧值卡住。
   */
  setSystemNames(map) {
    this.systemNames = map || {};
    this.emit();
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* 自定义本地应用                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * 全量角色定义（内置 + 自定义）。
   * engine 内部凡是要遍历角色，都走这里，不要再用静态 CHARACTERS。
   */
  characters() {
    return registry.allCharacters(this.state.customApps || [], this.state.customWebs || []);
  }

  addCustomWeb(site) {
    const url = String((site && site.url) || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return { ok: false, msg: '请输入有效的 HTTP/HTTPS 网址' };
    const id = 'web_' + registry.hashSeed(url).toString(36);
    const name = String((site && (site.name || site.title)) || '').trim().slice(0, 32) || url;
    const exist = this.state.customWebs.find((x) => x.id === id);
    if (exist) {
      exist.name = name;
      this.save();
      this.emit();
      return { ok: true, id, already: true };
    }
    this.state.customWebs.push({ id, url, name });
    const def = this.characters().find((c) => c.id === id);
    if (def && !this.state.runtime[id]) {
      this.state.runtime[id] = {
        hp: def.stamina, stress: 0, streak: 0, lastHitAt: 0, hits: 0,
        crashes: 0, strikes: 0, strikes_until: 0, state: 'idle', stateUntil: 0,
        tasksDone: 0
      };
    }
    this.save();
    this.emit();
    return { ok: true, id };
  }

  removeCustomWeb(id) {
    const before = this.state.customWebs.length;
    this.state.customWebs = this.state.customWebs.filter((x) => x.id !== String(id || ''));
    if (this.state.customWebs.length === before) return { ok: false, msg: '没找到这个网址' };
    delete this.state.runtime[id];
    if (this.state.names) delete this.state.names[id];
    this.state.tasks = (this.state.tasks || []).filter((t) => t.appId !== id);
    this.save();
    this.emit();
    return { ok: true };
  }

  listCustomWebs() {
    return this.state.customWebs.map((x) => Object.assign({}, x));
  }

  /* ---------------- 已接入清单（跨重启恢复连接） ---------------- */

  /** 记住一个已接入的 AI。重复接入去重；只动存档不 emit —— 它不影响任何界面状态。 */
  addConnection(appId) {
    const id = String(appId || '').trim();
    if (!id) return;
    if (!Array.isArray(this.state.connections)) this.state.connections = [];
    if (this.state.connections.includes(id)) return;
    this.state.connections.push(id);
    this.save();
  }

  /** 移除接入记录（断开时）。记录本来就不存在时静默通过。 */
  removeConnection(appId) {
    if (!Array.isArray(this.state.connections)) return;
    const before = this.state.connections.length;
    this.state.connections = this.state.connections.filter((x) => x !== String(appId || '').trim());
    if (this.state.connections.length !== before) this.save();
  }

  /** 一键清空：设置里的「清空所有连接」用，断开全部 + 不再自动恢复。 */
  clearConnections() {
    if (!Array.isArray(this.state.connections) || !this.state.connections.length) return;
    this.state.connections = [];
    this.save();
  }

  listConnections() {
    return Array.isArray(this.state.connections) ? this.state.connections.slice() : [];
  }

  /**
   * 用户主动把一个本地 App 加进驯兽场。
   *
   * 幂等：同一个 App 重复添加直接返回既有角色，不产生第二份。
   * 依据是 bundleId（比路径可靠，挪个位置也不会变成新角色）。
   *
   * @param {{appPath:string, name?:string, bundleId?:string, version?:string}} app
   */
  addCustomApp(app) {
    if (!Array.isArray(this.state.customApps)) this.state.customApps = [];
    const appPath = String((app && app.appPath) || '');
    if (!appPath) return { ok: false, msg: '缺少应用路径' };

    const bundleId = String((app && app.bundleId) || '');
    const id = registry.idForApp(appPath, bundleId);

    // 已经加过了：只更新可能变化的显示名，不重复插入
    const exist = this.state.customApps.find((a) => a.id === id);
    if (exist) {
      const nm = String((app && app.name) || '').trim();
      if (nm) exist.name = nm.slice(0, 24);
      this.save();
      this.emit();
      return { ok: true, id, already: true };
    }

    this.state.customApps.push({
      id,
      appPath,
      bundleId,
      name: String((app && app.name) || '').trim().slice(0, 24),
      version: String((app && app.version) || '')
    });

    // 自定义角色也得有运行时体征，否则 tick()里取不到 hp 会当成不存在
    const def = registry.allCharacters(this.state.customApps).find((c) => c.id === id);
    if (def && !this.state.runtime[id]) {
      this.state.runtime[id] = {
        hp: def.stamina,
        stress: 0,
        streak: 0,
        lastHitAt: 0,
        hits: 0,
        crashes: 0,
        strikes: 0,
        strikes_until: 0,
        state: 'idle',
        stateUntil: 0,
        bornAt: Date.now()
      };
    }

    this.save();
    this.emit();
    return { ok: true, id };
  }

  /**
   * 移除一个自定义应用。
   * 连同它的体征、自定义名一起清掉，避免存档越攒越多垃圾。
   * 内置角色传进来会直接拒绝 —— 那是产品自带的，不该被删。
   */
  removeCustomApp(id) {
    const key = String(id || '');
    if (BUILTIN_CHARACTERS.some((c) => c.id === key)) {
      return { ok: false, msg: '内置角色不能移除' };
    }
    if (!Array.isArray(this.state.customApps)) return { ok: false, msg: '没有可移除的' };

    const before = this.state.customApps.length;
    this.state.customApps = this.state.customApps.filter((a) => a.id !== key);
    if (this.state.customApps.length === before) return { ok: false, msg: '没找到这个应用' };

    delete this.state.runtime[key];
    if (this.state.names) delete this.state.names[key];
    // 运行中的任务也别留着悬空
    this.state.tasks = (this.state.tasks || []).filter((t) => t.appId !== key);

    this.save();
    this.emit();
    return { ok: true };
  }

  /** 列出用户已添加的自定义应用（界面「已添加」区用） */
  listCustomApps() {
    // H5 演示版没有 fs，路径存在性一律当作「存在」，不让它因此报错
    const exists = typeof fsx !== 'undefined' && fsx && fsx.existsSync ? (p) => {
      try {
        return fsx.existsSync(p);
      } catch (e) {
        return true;
      }
    } : () => true;

    return (this.state.customApps || []).map((a) => {
      const def = registry.allCharacters(this.state.customApps).find((c) => c.id === a.id);
      return Object.assign({}, a, {
        displayName: resolveDisplayName(a.id, def, this.state.names, this.systemNames),
        // 路径还在不在：应用被卸载/移动时要告诉用户，别让它成为僵尸角色
        exists: exists(a.appPath)
      });
    });
  }

  resetAll() {
    this.stop();
    this.state = this.freshState();
    this.save();
    this.start();
    this.emit();
    return { ok: true };
  }

  /* ---------------------------------------------------------------- */
  /* 快照                                                              */
  /* ---------------------------------------------------------------- */

  snapshot() {
    const now = Date.now();
    const tasks = this.state.tasks.map((t) => {
      const rate = (KIND_RATE[t.kind] || 3) * ((AFFINITY[t.appId] || {})[t.kind] || 1);
      const eta = t.status === 'running' ? Math.max(1, Math.round(((100 - t.progress) / rate) * (t.priority === 2 ? 0.75 : 1))) : 0;
      return {
        id: t.id,
        title: t.title,
        prompt: t.prompt,
        appId: t.appId,
        kind: t.kind,
        priority: t.priority,
        progress: t.mode === 'real' ? t.progress : Math.round(t.progress * 10) / 10,
        status: t.status,
        mode: t.mode,
        stage: stageOf(t.progress),
        etaSec: eta,
        revisions: t.revisions,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        doneAt: t.doneAt,
        logCount: (t.log || []).length
      };
    });

    // 走 characters()：自定义应用的角色也要出现在快照里，
    // 否则界面根本看不到它们，等于加了等于没加。
    const chars = this.characters().map((c) => {
      // 防御：体征可能缺失（比如 customApps 里有条目但 runtime 没建起来），
      // 直接取 rt.hp 会整张快照崩掉，界面上所有角色一起消失。
      const rt = this.state.runtime[c.id] || {
        hp: c.stamina,
        stress: 0,
        streak: 0,
        state: 'idle',
        hits: 0,
        crashes: 0,
        strikes: 0,
        tasksDone: 0,
        stateUntil: 0
      };
      const tasksOf = this.state.tasks.filter((t) => t.appId === c.id && t.status === 'running');
      return Object.assign({}, c, {
        // 界面唯一该显示的名字：自定义 > 本机真实名 > 系统默认名。
        // 渲染层只认这个字段，不再直接读 c.name（那是我们自己起的昵称）。
        displayName: resolveDisplayName(c.id, c, this.state.names, this.systemNames),
        // 用户挑选的角色形象 id（未挑过 = 自己）。渲染层画皮时用它。
        skin: this.state.skins[c.id] || c.id,
        hp: Math.round(rt.hp),
        maxHp: c.stamina,
        stress: Math.round(rt.stress),
        streak: Math.round(rt.streak),
        state: rt.state,
        hits: rt.hits,
        crashes: rt.crashes,
        strikes: rt.strikes,
        tasksDone: rt.tasksDone,
        activeTasks: tasksOf,
        stateUntil: rt.stateUntil
      });
    });

    return {
      ts: now,
      chars,
      tasks,
      apps: this.state.apps,
      settings: this.state.settings,
      stats: this.state.stats,
      feed: this.state.feed.slice(0, 25)
    };
  }

  taskLog(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    return t ? t.log || [] : [];
  }
}

const __exports = { Engine, TOOLS, stageOf, KIND_RATE, AFFINITY };
if (typeof module === 'object' && module.exports) module.exports = __exports;
else if (typeof window !== 'undefined') window.EngineModule = __exports;
