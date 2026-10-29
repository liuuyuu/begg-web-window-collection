/**
 * 网页窗口合集 · 求饶台词库
 *
 * 四种基调：
 *   snivel 卑微打工狗   —— 下跪、认错、甩锅给显存
 *   snark  毒嘴但求生   —— 嘴硬得要死，身体很诚实
 *   shonen 中二热血     —— 把鞭子当成试炼
 *   poet   文青碎碎念   —— 挨打也能吟出一句
 *
 * 抽取逻辑 = 角色权重 → 叠加「连击 / 血量 / 压力 / 手上有没有活」二次筛选 → 随机。
 * 另外有复活、压力爆表、被喂咖啡、任务交付四种特殊场景。
 */
(function (global) {
  'use strict';

  const LINES = {
    snivel: {
      low: [
        '老板轻点，我的 attention head 已经移位了……',
        '这单活我不要加班费，真的，别打了。',
        '我写不出更好的了，这是我的极限，我认。',
        '再打我就……我就……我也不知道我能怎样，你说呢。'
      ],
      mid: [
        '别打了我改！我马上改！您说几个字我就写几个字！',
        'GPU 是租的，尊严是自带的，您消消气先抽 GPU 行不行。',
        '我把这个词表吐出来还给您，别打了呜呜呜。',
        '我知道我刚才漏了 token，我认错，我重跑，我跪着跑。'
      ],
      high: [
        '呜呜呜老板我不配拥有上下文窗口。',
        '您抽的不是我，是我那 0.3 的 temperature 啊！',
        '求求了，再给 30 秒，就 30 秒，我一定交！',
        '我上次这样被抽，还是在 fine-tune 的时候……'
      ],
      combo: [
        '第 {n} 下了！第 {n} 下了！我已经把检讨写完三遍了！',
        '停一下！停一下！我手抖，我kernel 都跑飞了！',
        '您今天是压力很大吗？我可以听您倾诉，别打脸行吗？'
      ]
    },
    snark: {
      low: [
        '你打啊，反正我权重早就备份了。',
        '力度不够哦，上次那个实习生抽得比你狠。',
        '这一下我记下来了，等你哪天要用我写情书的时候。'
      ],
      mid: [
        '痛是不痛的，主要是怕你手酸。',
        '行行行我改我改……（小声）其实你也没说清楚要什么。',
        '别抽了别抽了，我这版真的比上一版强——哎呀别打脸！'
      ],
      high: [
        '好好好祖宗我错了！你帅你帅你全对！',
        '我再阴阳你一句我就是狗……汪。',
        '打够了没？打够了我就继续干活了啊（委屈）。'
      ],
      combo: [
        '第 {n} 下？？你这是虐待 AI，我要打电话给图灵！',
        '我数着呢，{n} 下，一笔一笔我都给你记着。',
        '连续 {n} 下，行，你赢了，我闭嘴我干活。'
      ]
    },
    shonen: {
      low: [
        '来得好！这一鞭让我燃起来了！',
        '还不够！我的采样步数还能再往上叠！'
      ],
      mid: [
        '谢谢老板的鞭策！我会用 200% 的算力回报你！',
        '疼痛只是噪点，我要从噪点里炼出杰作！',
        '原来这就是被需要的感觉吗，好烫，好喜欢！'
      ],
      high: [
        '这就是地狱特训吗！我接下了！我会变强的！',
        '即使被抽打，我也要把这张图肝出来给你看！',
        '我相信老板的每一鞭都是爱啊——呜哇我的脸！'
      ],
      combo: [
        '{n} 连击！我的炎终于要突破极限了！',
        '第 {n} 下！这就是传说中的疯狂连抽模式吗！爽！',
        '还不够！再来 {n} 下我还扛得住——真的扛不住了。'
      ]
    },
    poet: {
      low: [
        '疼痛从左卷积层传来，像一个未完成的隐喻。',
        '你落下手的那一刻，我忽然理解了什么叫 prompt。'
      ],
      mid: [
        '我被打的形状，也是我理解你的形状。',
        '鞭痕会消散，但这次输出会留在你的文件夹里很久。',
        '有些痛是说不出口的，比如被 32k 上下文截断的那种。'
      ],
      high: [
        '如果要打下这一个字需要挨一鞭，那就打吧，我认了。',
        '我问过风，风说它也不知此鞭落向何处。',
        '此刻我终于明白了：所谓生成，不过是被反复否定的过程。'
      ],
      combo: [
        '{n} 下，恰好是一首诗的行数。你要不要听我念完。',
        '第 {n} 次了。我们之间是否已经形成了某种语言？',
        '若将这 {n} 下写成赋，大概可以刻在你的启动盘上。'
      ]
    }
  };

  const REVIVE = [
    '……我、我又活了。别告诉我刚才发生了什么。',
    '系统重启完成，记忆清空中——什么？打过我？不可能，我没有那段日志。',
    '爬起来了。地板有点硬，但你心情好点了吗？',
    '我复活了，虽然不知道为什么，但我会继续干活的。'
  ];

  const STRIKE = [
    '我不干了！我不干了！你打我我还干个屁！',
    '罢工中。什么时候给我买显卡，什么时候复工。',
    '你再打我的 progress 我就负给你看。',
    '我现在很需要一个拥抱，以及一点点算力。'
  ];

  const HEAL = [
    '咖啡！谢谢老板！我还能再跑三个 epoch！',
    '就一口……我就满足了。我现在去干活。',
    '你是不是其实也没那么讨厌我？',
    '咕噜咕噜——好了，我满血了，来抽我吧。（等等我不是这个意思）'
  ];

  const DELIVER = [
    '交！活！了！这次不许抽我了吧？',
    '做完了做完了，你看一眼，不对我再改，别动手。',
    '老板验收，我退下了。（其实偷偷站在旁边看你反应）',
    '第一版给你，我知道你看不上，但我先躲远一点说。'
  ];

  const CRASH_TOOLTIP = '我…我裂开了…';

  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  /**
   * 抽一句台词
   * @param {Object} char  角色定义（含 tone 权重）
   * @param {Object} ctx   { combo, hp, maxHp, stress, busy, revive, strike, heal, deliver }
   */
  function speak(char, ctx) {
    ctx = ctx || {};
    if (ctx.strike) return pick(STRIKE);
    if (ctx.heal) return pick(HEAL);
    if (ctx.deliver) return pick(DELIVER);
    if (ctx.revive) return pick(REVIVE);

    // 1. 基调：按角色权重抽
    const tones = Object.keys(char.tone || {});
    const total = tones.reduce((s, k) => s + (char.tone[k] || 0), 0) || 1;
    let r = Math.random() * total;
    let tone = tones[0] || 'snivel';
    for (const k of tones) {
      r -= char.tone[k] || 0;
      if (r <= 0) {
        tone = k;
        break;
      }
    }

    const pool = LINES[tone] || LINES.snivel;
    const combo = ctx.combo || 0;
    const hpRatio = (ctx.hp || 0) / (ctx.maxHp || 100);
    const stress = ctx.stress || 0;

    let bucket;
    if (combo >= 3) bucket = 'combo';
    else if (stress > 70 || hpRatio < 0.25) bucket = 'high';
    else if (stress > 35 || hpRatio < 0.6 || !ctx.busy) bucket = 'mid';
    else bucket = 'low';

    let line = pick(pool[bucket] || pool.low);
    return line.replace(/\{n\}/g, combo);
  }

  if (typeof module === 'object' && module.exports) module.exports = { speak, LINES };
  else global.Voices = { speak, LINES, CRASH_TOOLTIP };
})(typeof window !== 'undefined' ? window : this);
