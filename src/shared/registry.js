/**
 * 网页窗口合集 · 运行时角色注册表
 *
 * 为什么要这个文件：
 *   原来 12 个角色全部写死在 shared/characters.js 里，只有 AI。
 *   用户后来提了个很合理的要求 ——「能不能我自己去连本地 App，不限于 AI 相关的」。
 *   但 CHARACTERS 是模块加载时就固定的数组，engine / 渲染层都直接
 *   拿它做find()，光改 UI 是接不上的。
 *
 * 所以这里把「角色」从常量变成运行时可注册的对象：
 *   内置 AI  → 静态定义（保持原样，一行不改）
 *   任意 App → 用户自己加进来，运行时生成一个角色
 *
 * 设计要点：
 *   1. 外观**从 app 身份确定性派生**（名字哈希 → 配色 / 配件 / 眼睛）。
 *      同一个 App 每次生成的长相完全一致，刷新页面不会换脸；
 *      不同 App 之间差异明显，一眼能分清谁是谁。
 *   2. 血量、脾气等数值同样按名字哈希给出，
 *      免得所有新角色都是 100 血、同一套台词。
 *   3. 自定义角色的台词走通用文案池，不假装它是某个 AI。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/characters'));
  else root.AI_TAMER_REGISTRY = factory(root.AI_TAMER_CHARACTERS);
})(typeof self !== 'undefined' ? self : this, function (CHARACTERS_MOD) {
  'use strict';

  const BUILTIN = CHARACTERS_MOD.CHARACTERS || [];

  /**
   * 可用的配件 / 眼睛造型。
   * 必须取自 shared/characters.js 里 renderer/js/characters.js 真正画得出来的那些，
   * 否则会静默渲染成空白（那边switch 有 default: return ''）。
   */
  const ACCESSORIES = ['halo', 'spark', 'star', 'horns', 'beret', 'plug', 'headphone', 'crescent', 'flower', 'film', 'swirl', 'badge', 'braces'];
  const EYES = ['round', 'visor', 'slit', 'sleepy', 'glasses'];

  /**
   * 32 位字符串哈希（FNV-1a）。
   * 用它把「App 名字」变成一个稳定的数字种子 —— 同一个名字永远得到同一个种子，
   * 这是「刷新不换脸」的前提。
   */
  function hashSeed(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  /** 用种子稳定地从数组里取一个元素 */
  function pickBy(seed, arr, salt) {
    return arr[(seed + (salt || 0) * 2654435761) % arr.length];
  }

  /**
   * 由种子生成一组「果冻渐变」配色。
   * 走 HSL 而不是直接随机 RGB —— 保证亮度可控，不会出现洗白的浅色，
   * 也不会出现深到看不清五官的黑色。这是纯随机 RGB 最容易翻车的地方。
   */
  function paletteFrom(seed) {
    const hue = seed % 360;                 // 主色相
    const hue2 = (hue + 28 + (seed % 40)) % 360; // 邻近色相，做渐变
    const hue3 = (hue + 200 + (seed % 60)) % 360; // 补色，压暗用

    return {
      a: hsl(hue, 92, 78),   // 最亮 → 高光
      b: hsl(hue2, 74, 58),  // 中间 → 主体
      c: hsl(hue3, 52, 30),  // 最暗 → 阴影
      glow: hsl(hue, 100, 92),// 发光
      cheek: hsl(hue2, 88, 68) // 腮红
    };
  }

  function hsl(h, s, l) {
    // 手写 HSL→RGB，避免为主进程引依赖（只为了取个颜色不值当）
    const S = s / 100;
    const L = l / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to255 = (v) =>
      Math.max(0, Math.min(255, Math.round(v * 255)))
        .toString(16)
        .padStart(2, '0');
    return ('#' + to255(f(0)) + to255(f(8)) + to255(f(4))).toUpperCase();
  }

  /** 台词池：自定义角色不该假装自己是某个 AI，用通用文案更诚实 */
  const GENERIC_TAGS = [
    '本机常驻，随叫随到。',
    '不联网，只干活。',
    '你装它的时候它就位了。',
    '本地跑的主儿，脾气看磁盘。',
    '不用登录，不上传。',
    '就在 Dock 里，从没关过。',
    '干活不聊天，只出结果。',
    '安静待命，别抽太狠。'
  ];

  const GENERIC_QUIPS = [
    '「这活儿我熟，别催。」',
    '「磁盘在转，我也在转。」',
    '「没联网，放心。」',
    '「你倒是先说清要什么。」',
    '「又抽？我缓存都还没写完。」',
    '「我又不是 AI，别按 AI 的标准骂我。」',
    '「这个窗口我自己会关。」',
    '「行吧，反正我跑不掉。」'
  ];

  const GENERIC_TRAITS = ['本机常驻', '不联网', '离线可用'];

  /**
   * 由一个 .app 应用生成运行时角色定义。
   *
   * @param {string} appPath 绝对路径，如 /Applications/WeChat.app
   * @param {object} meta     { name, bundleId, version } 来自 inspectApp
   * @returns {object} 与内置角色同构的角色定义
   */
  function fromApp(appPath, meta) {
    const info = meta || {};
    // 用 bundleId 优先做种子：同一个 App 改名（displayName 变了）时长相不变
    const seed = hashSeed(info.bundleId || appPath || info.name || 'app');

    const display = String(info.name || '').trim() || '未命名应用';

    return {
      id: null, // 由调用方按bundleId 生成唯一 id 后填入
      name: display,
      app: display,
      title: '本地应用',
      tag: pickBy(seed, GENERIC_TAGS, 1),
      quip: pickBy(seed, GENERIC_QUIPS, 2),
      accessory: pickBy(seed, ACCESSORIES, 3),
      eyes: pickBy(seed, EYES, 4),
      palette: paletteFrom(seed),
      // 血量 75~130，按种子给：皮实程度也随机，比清一色 100 有意思
      stamina: 75 + (seed % 56),
      baseSpeed: 0.85 + ((seed >> 3) % 40) / 100, // 0.85~1.24
      tone: { snivel: 1 + (seed % 3), snark: (seed >> 2) % 4, poet: (seed >> 4) % 3, shonen: (seed >> 5) % 3 },
      traits: GENERIC_TRAITS,

      // --- 以下是「自定义角色」特有字段，内置角色没有 --- */
      custom: true,               // 渲染层据此显示「移除」按钮
      appPath: appPath || '',
      bundleId: info.bundleId || '',
      version: info.version || ''
    };
  }

  function fromWeb(url, meta) {
    const info = meta || {};
    const display = String(info.name || info.title || '').trim() || url;
    const seed = hashSeed(url);
    return {
      id: null,
      name: display,
      app: display,
      title: '网页应用',
      tag: '在驯兽场里打开的自定义网页。',
      quip: '「网页已接入，直接说要做什么。」',
      accessory: pickBy(seed, ACCESSORIES, 3),
      eyes: pickBy(seed, EYES, 4),
      palette: paletteFrom(seed),
      stamina: 90 + (seed % 31),
      baseSpeed: 1,
      tone: { snivel: 2, snark: 2, poet: 2, shonen: 2 },
      traits: ['网页内嵌', '独立登录态', '客户自定义'],
      customWeb: true,
      url
    };
  }

  /**
   * 生成稳定的角色 id。
   * 用 bundleId 更好：同一个 App 不管路径怎么挪，id 都不变。
   * bundleId 缺失时退化到目录名 + 路径哈希，保证不同 App 不会撞 id。
   */
  function idForApp(appPath, bundleId) {
    if (bundleId) {
      return (
        'app_' +
        bundleId
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 40)
      );
    }
    return 'app_' + hashSeed(appPath || 'unknown').toString(36);
  }

  /**
   * 角色表：内置 + 自定义。
   * 引擎与渲染层都应当用这个函数拿全量角色，不要再直接用 CHARACTERS。
   *
   * @param {Array} customApps 用户添加的应用列表，形如
   *        [{ appPath, bundleId, name, version }]
   * @returns {Array} 全量角色定义（自定义角色排在后面）
   */
  function allCharacters(customApps, customWebs) {
    const extra = (customApps || []).map((it) => {
      const c = fromApp(it.appPath, it);
      c.id = it.id || idForApp(it.appPath, it.bundleId);
      c.name = it.name || c.name;
      c.app = it.name || c.app;
      return c;
    });

    const webs = (customWebs || []).map((it) => {
      const c = fromWeb(it.url, it);
      c.id = it.id || ('web_' + hashSeed(it.url).toString(36));
      return c;
    });
    const seen = new Set(BUILTIN.map((c) => c.id));
    // 自定义角色若与内置 id 冲突（理论上不会，id 前缀不同），跳过避免串味
    return BUILTIN.concat(extra.filter((c) => !seen.has(c.id))).concat(webs.filter((c) => !seen.has(c.id)));
  }

  return { BUILTIN, allCharacters, fromApp, fromWeb, idForApp, hashSeed, ACCESSORIES, EYES };
});
