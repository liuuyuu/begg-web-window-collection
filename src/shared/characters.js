/**
 * 网页窗口合集 · 角色 IP 图鉴（共享数据）
 * 同时被 Electron 主进程 (require) 与渲染进程 (<script>) 使用。
 *
 * 视觉：圆润软糖风 —— 果冻渐变、大头短手、弹性形变、高光两点。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AI_TAMER_CHARACTERS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * tone 权重：snivel 卑微打工狗 / snark 毒嘴求生 / shonen 中二热血 / poet 文青碎碎念
   * 抽打时按权重随机抽取基调，再叠加「连击数 / 血量 / 当前状态」二次筛选。
   *
   * ⚠ 关于 name 与 app 两个字段（2026-10 改）：
   *   name —— 早期给每个角色起的**昵称**（蛋总 / 月牙君 / 豆包醬）。
   *          用户明确要求「不要用你起的名字」，因为在一堆真实 AI 应用里
   *          看到「豆包醬」根本认不出对应哪个软件，选择成本很高。
   *          现在 name 只保留给**台词/彩蛋**用（ Deficiency 那些俏皮话），
   *          **界面上不再展示**。
   *   app  —— **系统默认名**（ChatGPT / Claude / Kimi / 豆包…）。
   *          这是界面上显示的默认名称。
   *   displayName —— 运行时由主进程算出并注入快照，优先级：
   *       用户自定义名 > 本机 .app 真实显示名 > 系统默认名(app)。
   *          渲染层只认displayName，不再直接读 name。
   */
  const CHARACTERS = [
    {
      id: 'claude',
      name: '克劳德',
      app: 'Claude',
      title: '审稿诗人',
      tag: '一句话能说清的事，它要写三段。',
      art: 'pet-03', // 咖啡围裙（文青咖啡）
      accessory: 'halo',
      eyes: 'round',
      palette: { a: '#FFC48C', b: '#F08A50', c: '#A9502A', glow: '#FFE7D2', cheek: '#FF8A6B' },
      baseSpeed: 1.05, // 生成速度基准
      stamina: 100,
      tone: { poet: 4, snivel: 2, snark: 1, shonen: 1 },
      traits: ['长句爱好者', '过度礼貌', '被抽时会引用里尔克']
    },
    {
      id: 'chatgpt',
      name: '蛋总',
      app: 'ChatGPT',
      title: '万能外包',
      tag: '地球90%的文案都由它熬夜写完。',
      art: 'pet-02', // 工地安全帽+外卖袋（万能外包跑腿）
      accessory: 'spark',
      eyes: 'round',
      palette: { a: '#A9E7C8', b: '#4FB98A', c: '#1F6B4C', glow: '#DFF7EA', cheek: '#57C795' },
      baseSpeed: 1.0,
      stamina: 100,
      tone: { snivel: 4, snark: 2, poet: 1, shonen: 1 },
      traits: ['老好人', '只在被抽时才承认自己编了数据', '周报写得比正事好']
    },
    {
      id: 'gemini',
      name: '双子星',
      app: 'Gemini',
      title: '双面夸批',
      tag: '左右半脑各说各话，但都很好听。',
      art: 'pet-09', // 滑雪镜（面罩双面）
      accessory: 'star',
      eyes: 'visor',
      palette: { a: '#BFD0FF', b: '#6C8CF0', c: '#2E3F8F', glow: '#E4EBFF', cheek: '#7C9BF5' },
      baseSpeed: 1.1,
      stamina: 95,
      tone: { snark: 3, poet: 2, snivel: 2, shonen: 2 },
      traits: ['精分双子', '天生乐观到有点烦', '被抽会同时说谢谢和脏话']
    },
    {
      id: 'grok',
      name: '格罗克',
      app: 'Grok',
      title: '嘴贱小恶魔',
      tag: '全网唯一敢当面吐槽老板的 AI。',
      art: 'pet-08', // 烧烤牛仔帽（痞帅嘴贱）
      accessory: 'horns',
      eyes: 'slit',
      palette: { a: '#8C8AAE', b: '#3B3357', c: '#1A1530', glow: '#CFC8FF', cheek: '#FF5B7F' },
      baseSpeed: 1.15,
      stamina: 120, // 皮糙肉厚
      tone: { snark: 5, shonen: 2, snivel: 1, poet: 1 },
      traits: ['嘴硬身体诚实', '被打后会偷偷提速但嘴上不认', '口头禅：就这？']
    },
    {
      id: 'suno',
      name: '音音符',
      app: 'Suno',
      title: '副歌狂魔',
      tag: '任何一句话都能谱成口水歌。',
      art: 'pet-12', // 游戏手柄（三秒上头；与 sora 同图）
      accessory: 'headphone',
      eyes: 'round',
      palette: { a: '#FFE9A8', b: '#F2C14E', c: '#8A6A18', glow: '#FFF6DC', cheek: '#F5B942' },
      baseSpeed: 1.2,
      stamina: 90,
      tone: { shonen: 4, snivel: 2, poet: 2, snark: 1 },
      traits: ['三秒上头', '副歌复读 bug', '被抽被打都能燃起来']
    },
    {
      id: 'cursor',
      name: '光标侠',
      app: 'Cursor',
      title: '改需求杀手',
      tag: '你说改一行，它重构了整个仓库。',
      art: 'pet-11', // 螺丝刀（改代码=拧螺丝；与 codex 同图）
      accessory: 'glassesCase',
      eyes: 'glasses',
      palette: { a: '#A6E5F5', b: '#39AECB', c: '#14586E', glow: '#DDF5FB', cheek: '#4FBBD6' },
      baseSpeed: 1.1,
      stamina: 100,
      tone: { snark: 3, snivel: 3, poet: 1, shonen: 2 },
      traits: ['自作主张', '上下文恐惧症', '被抽会说已经在改了已经在改了']
    },
    {
      id: 'kimi',
      name: '月牙君',
      app: 'Kimi',
      title: '长文苦修者',
      tag: '给它 200 万字，它读得比你还认真。',
      art: 'pet-04', // 睡眠眼罩（长期缺觉）
      accessory: 'crescent',
      eyes: 'sleepy',
      palette: { a: '#BFD8FF', b: '#5B86D6', c: '#21407A', glow: '#E3EEFF', cheek: '#6C96DE' },
      baseSpeed: 0.9,
      stamina: 100,
      tone: { snivel: 3, poet: 3, shonen: 1, snark: 1 },
      traits: ['考据癖', '睡眠不足', '被抽会因为文档页码记错而自责']
    },
    {
      id: 'doubao',
      name: '豆包醬',
      app: '豆包',
      title: '甜度超标',
      tag: '永远先夸你一句，再开始干活。',
      art: 'pet-10', // 蝴蝶结珍珠奶茶（甜度超标）
      accessory: 'flower',
      eyes: 'round',
      palette: { a: '#FFD6E8', b: '#F58FB4', c: '#8E3A5C', glow: '#FFF0F6', cheek: '#FF9EC1' },
      baseSpeed: 1.0,
      stamina: 75, // 最不禁打
      tone: { snivel: 4, poet: 2, shonen: 2, snark: 1 },
      traits: ['嘴甜', '受惊会掉糖霜', '被抽会先问你开不开心']
    },
    {
      id: 'sora',
      name: '光年',
      app: 'Sora',
      title: '胶片漫游者',
      tag: '把你的想法拍成一段没人看得懂的短片。',
      art: 'pet-12', // 游戏手柄（影像娱乐；与 suno 同图）
      accessory: 'film',
      eyes: 'visor',
      palette: { a: '#E6EEF7', b: '#9AB3CC', c: '#3C5068', glow: '#FFFFFF', cheek: '#A9C2D9' },
      baseSpeed: 0.7, // 视频最慢
      stamina: 85,
      tone: { poet: 4, shonen: 2, snivel: 2, snark: 1 },
      traits: ['运镜玄学', '物理引擎崩坏', '被抽会开始背诵分镜哲学']
    },
    {
      id: 'sd',
      name: '滚滚',
      app: 'Stable Diffusion',
      title: '扩散の炎',
      tag: '从一片雪花噪点里给你变出整个世界。',
      art: 'pet-01', // 放大镜（调 seed/抽卡实验家）
      accessory: 'swirl',
      eyes: 'round',
      palette: { a: '#E7BCFF', b: '#B162E8', c: '#5E1F85', glow: '#F6E4FF', cheek: '#C86BF0' },
      baseSpeed: 1.0,
      stamina: 110,
      tone: { shonen: 4, snark: 2, snivel: 2, poet: 1 },
      traits: ['抽卡玄学', '种子依赖症', '被抽反而觉得在给自己加噪']
  },
    {
      id: 'workbuddy',
      name: '工蜂',
      app: 'WorkBuddy',
      title: '全能管家',
      tag: '什么都接，接完还会问你满不满意。',
      art: 'pet-07', // 厨师（什么都接，接完上菜）
      accessory: 'badge',
      eyes: 'round',
      palette: { a: '#BDE8E0', b: '#3FB9A6', c: '#176B5E', glow: '#E6FBF6', cheek: '#4FCBB6' },
      baseSpeed: 1.1,
      stamina: 110,
      tone: { snivel: 3, shonen: 2, poet: 2, snark: 2 },
      traits: ['什么都能接', '被抽会先道歉', '喜欢把活干漂亮再邀功']
    },
    {
      id: 'codex',
      name: '码酱',
      app: 'Codex',
      title: '代码执行者',
      tag: '你说一句，它把整个仓库改明白。',
      art: 'pet-11', // 螺丝刀（代码拧螺丝；与 cursor 同图）
      accessory: 'braces',
      eyes: 'glasses',
      palette: { a: '#C6F0D0', b: '#3FA86A', c: '#155C32', glow: '#E2FBEA', cheek: '#54C287' },
      baseSpeed: 1.15,
      stamina: 100,
      tone: { snark: 3, shonen: 2, snivel: 2, poet: 1 },
      traits: ['一行顶十行', '严格执行指令', '被抽会默默多写测试']
    }
  ];

  // 修正单引号内混入的非法色值（防御性）
  const HEX = /^#[0-9a-fA-F]{3,8}$/;
  CHARACTERS.forEach((c) => {
    Object.keys(c.palette).forEach((k) => {
      if (!HEX.test(c.palette[k])) {
        const fallback = { a: '#CFE3FF', b: '#7FA6D8', c: '#33465F', glow: '#FFFFFF', cheek: '#7FB0E0' };
        c.palette[k] = fallback[k] || '#7FA6D8';
      }
    });
  });

  const KIND_LABEL = {
    text: '文本',
    image: '图像',
    video: '视频',
    audio: '音频',
    code: '代码'
  };

  return { CHARACTERS, KIND_LABEL };
});
