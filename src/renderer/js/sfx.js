/**
 * 全合成音效（不引入任何音频文件）
 * WebAudio 现场合成：水枪的 biu、手枪的枪响、加特林的连射、雷的轰鸣、
 * 拖鞋的 pia、以及 AI 的呜咽。
 *
 * ── 2026-10-12 重写 ────────────────────────────────────────────────
 * 用户反馈「你系统生成的音效我不满意」，要求往写实走。
 *
 * 旧版病根：每段音只有「一条噪声 + 一个扫频正弦」，两三个声音元素叠一叠就完事。
 * 所以听起来电子、单薄、没有体积，也不像任何真实物体发出的声音。
 *
 * 写实录音的共同结构其实是四层，这次全部按四层来拼：
 *   ① 瞬态 transient —— 击打那一瞬间的高频爆点（几毫秒），决定「力度」
 *   ② 主体 body      —— 低频/中频能量，决定「体积」和音高
 *   ③ 尾音 tail      —— 指数衰减的余响，决定「质感」
 *   ④ 空间 space     —— 卷积混响（指数衰减噪声现场当脉冲响应），把前三层粘起来
 * 只做①的听起来像「电子音效」，只做②③的像「远处闷响」，四层齐了才像录音。
 *
 * 发声体各不相同，不是同一条噪声换个参数：
 *   whip    —— 抽打：鞭梢破空 + 抽到皮肉的「啪」+ 低频肉响 + 挥动气流
 *   water   —— 「biu」：音高先上冲再回落 + 喷雾嘶声 + 随机水珠
 *   gun     —— 亚毫秒爆音 + 低频膛音 + 三次早反射 + 长尾残响
 *   gatling —— 把 gun 的发声体以 42ms 间隔连按 8 次 + 转管电机底噪（多重枪响叠加）
 *   thunder —— 闪电放电火花 + 炸裂（爆）+ 下坠低频冲击（轰）+ 四层错开的隆隆（鸣）
 *   slipper —— 「pia」：p 送气 + 拍击脆响 + **元音共振峰 i→a 滑动**（voice）
 *   coffee  —— 喝进去：一记咕咚（下坠音高 + 水声）；好起来：两记往上走的暖铃 + 碎光
 *   whimper —— 人声共振峰：锯齿波过三条带通滤波器做元音，带颤音与换气
 *   crash   —— 重物砸地的闷响 + 低频下坠 + 四散的碎屑声
 *   ding    —— 钟的非谐分音（1 / 2 / 2.76 / 5.4 / 8.93 倍），高次分音衰减更快
 *
 * ── 2026-10-12 第二轮（用户：我的提议都是希望这个声音更真实）────────
 *   1. 皮鞭改用「水枪」音（app.js 映射，非本文件）
 *   2. 水枪要有「biu」—— 水射出去的那一记（音高上冲再回落）
 *   3. 枪声要真实 —— 补三次离散早反射，空间感来自回声不是混响
 *   4. 雷声要「轰鸣 + 爆炸」—— 爆、轰、鸣拆成三段分别做
 *   5. 手枪 / 加特林拆开 —— 加特林 = 手枪连击 8 发
 *   6. 拖鞋要有「pia」—— 补 i→a 的下滑音高线
 *
 * ── 2026-10-12 第三轮（用户：你这一版声音完全乱了！）──────────────
 * 最要紧的一条不是音色，是**接线错了**：app.js 里每次打击都在道具音后面
 * 无条件补一记 whimper，所以满耳朵都是呜咽。现在呜咽只留给血条清零那一刻。
 *   1. 呜咽只在血条清零时响（crash 之后 180ms 补一记）
 *   2. 皮鞭还原成自己的抽打声（第二轮「借水枪声」的做法作废）
 *   3. 雷罚补「闪电放电」的一簇火花 —— 闪电（电）和雷（声）是两件事
 *   4. 咖啡换成「喝水 + 加血」：咕咚下坠 + 暖铃上行
 *   5. 上一轮 coffee 是唯一没动的，这一轮它也改了 ——
 *      至此 9 段音效**全部**是新版合成，旧版原语 noise()/tone() 已删除
 *
 * 试听台：项目根 sfx-audition.html，可逐条试听并与旧版 A/B 对比。
 * 另外 `npm run sfx:wav` 可把任意音效渲成 wav 文件（新旧各一份）直接听。
 *
 * ── 2026-10-12 第五轮（用户提供真实录音）────────────────────────
 * 皮鞭 / 拖鞋 / 喝咖啡三段改播**用户给的 mp3 素材**（assets/sfx/ 下，
 * base64 内嵌进 sfx-samples.js —— file:// 页面 fetch 本地音频会被同源
 * 策略拦，内嵌成 data URI 走 atob + decodeAudioData 零协议风险）。
 *   · 解码后自动做 RMS 响度对齐（目标 0.055）：素材彼此响度差 6 倍以上
 *     （加血 RMS 0.02 vs 鞭子 0.14），不拉齐的话换一个道具音量跳一大截。
 *     对齐后峰值若超过 0.85 再压回来，限幅器之外再留一道保险。
 *   · 素材没解码好（启动后 1s 内）或解码失败时，回落到下面的合成版 ——
 *     每段音的合成实现都保留，永远有声音响。
 *
 * ── 2026-10-12 第七轮（用户：回血音效是吞 3 口口水，截成 1 口）────────
 * 加了 SAMPLE_TRIM 裁剪表：只播素材的一个时间窗口，不重新编码。
 *   · coffee 原录音 2.32s，包络实测三记吞咽在 0.17-0.37 / 1.03-1.17 /
 *     1.93-2.05s → 只取第一口 0.15-0.42s。
 *   · 播放窗口同时是**响度对齐的统计窗口**：拿含静音的整条算 RMS 会把
 *     只播一小段的素材补得过响。
 *   · 尾端 30ms 淡出，切口不留「啪」的爆点。
 *   · 连续打击时多个 BufferSource 重叠播放，天然混音，与真实抽打一致。
 * 其余七段仍为纯合成。
 */
(function (global) {
  'use strict';

  let ctx = null;
  let enabled = true;
  let master = null;      // 新版音效的总线出口
  let masterCtx = null;   // master 属于哪个 context（离线渲染会换 context）
  let verbIn = null;      // 混响送入口

  function ac() {
    // 测试钩子：注入 OfflineAudioContext 就能离线渲染、把包络量出来
    const forced = global.__SFX_CTX__;
    if (forced) {
      if (ctx !== forced) { ctx = forced; master = null; masterCtx = null; verbIn = null; }
      return ctx;
    }
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* ================= 总线 ================= */

  /**
   * 脉冲响应：指数衰减的噪声。听着就是一个房间，不用引任何素材。
   * 左右声道衰减速度差 1.5%，出来才有立体声宽度。
   */
  function impulse(c, seconds, decay) {
    const len = Math.max(1, Math.floor(c.sampleRate * seconds));
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const k = ch ? 1.015 : 1;
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) * k;
      }
    }
    return buf;
  }

  /**
   * 主干：主增益 → 限幅器 → 输出；另有一条混响支路。
   * 限幅器是必需的 —— 四层叠起来峰值会超过 1.0，不限就削顶出爆音。
   */
  function bus(c) {
    if (master && masterCtx === c) return master;
    masterCtx = c;

    const lim = c.createDynamicsCompressor();
    lim.threshold.value = -4;
    lim.knee.value = 4;
    lim.ratio.value = 16;
    lim.attack.value = 0.002;
    lim.release.value = 0.18;
    lim.connect(c.destination);

    master = c.createGain();
    master.gain.value = 1;
    master.connect(lim);

    const conv = c.createConvolver();
    conv.buffer = impulse(c, 1.2, 2.6);
    const wet = c.createGain();
    wet.gain.value = 0.9;
    conv.connect(wet);
    wet.connect(lim);
    verbIn = conv;
    return master;
  }

  function sendTo(c, g, amount) {
    if (!amount || !verbIn) return;
    const s = c.createGain();
    s.gain.value = amount;
    g.connect(s);
    s.connect(verbIn);
  }

  /** 一段可循环的白噪声，各层按随机偏移取用 —— 省掉每次发声重新分配 buffer */
  let noiseBuf = null;
  function noiseSrc(c) {
    if (!noiseBuf) {
      const len = Math.floor(c.sampleRate * 5);
      noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  /* ================= 两个发声层 ================= */

  /**
   * 噪声层：滤波（可扫频）+ 指数包络。写实音效的骨架。
   * o.type 滤波类型 / o.f0→o.f1 扫频 / o.q 谐振 / o.atk 起振 / o.dur 衰减时长
   * o.gain 峰值 / o.at 相对延迟 / o.send 送混响的量
   */
  function layer(c, o) {
    const atk = Math.max(0.0006, o.atk == null ? 0.002 : o.atk);
    const t0 = c.currentTime + (o.at || 0);
    const src = noiseSrc(c);

    const f = c.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.Q.value = o.q == null ? 1 : o.q;
    const a = Math.max(20, o.f0);
    const b = Math.max(20, o.f1 == null ? o.f0 : o.f1);
    f.frequency.setValueAtTime(a, t0);
    if (b !== a) f.frequency.exponentialRampToValueAtTime(b, t0 + (o.sweep || o.dur));

    const g = c.createGain();
    const peak = Math.max(0.0002, o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + o.dur);

    src.connect(f);
    f.connect(g);
    g.connect(bus(c));
    sendTo(c, g, o.send);

    src.start(t0, Math.random() * 2);
    src.stop(t0 + atk + o.dur + 0.05);
  }

  /** 音高层：振荡器 + 指数包络，可扫频。用来做膛音、闷响、钟的泛音。 */
  function body(c, o) {
    const atk = Math.max(0.001, o.atk == null ? 0.004 : o.atk);
    const t0 = c.currentTime + (o.at || 0);
    const osc = c.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.f0), t0);
    const f1 = o.f1 == null ? o.f0 : o.f1;
    if (f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + (o.sweep || o.dur));
    }

    const g = c.createGain();
    const peak = Math.max(0.0002, o.gain);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + o.dur);

    osc.connect(g);
    g.connect(bus(c));
    sendTo(c, g, o.send);

    osc.start(t0);
    osc.stop(t0 + atk + o.dur + 0.05);
  }

  /**
   * 人声层：锯齿波过三条带通滤波器（共振峰），元音就是这么出来的。
   * 单靠正弦扫频永远像电子音 —— 人类耳朵对共振峰结构极其敏感，
   * 凑出 F1/F2/F3 才有「生物在哼」的感觉。
   */
  function voice(c, o) {
    const atk = o.atk == null ? 0.03 : o.atk;
    const t0 = c.currentTime + (o.at || 0);
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(Math.max(20, o.f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);

    // 颤音：真人声不可能是一条直的音高线
    const lfo = c.createOscillator();
    lfo.frequency.value = o.vib || 5.5;
    const lg = c.createGain();
    lg.gain.value = o.vibDepth == null ? 7 : o.vibDepth;
    lfo.connect(lg);
    lg.connect(osc.frequency);

    const amp = c.createGain();
    const peak = Math.max(0.0002, o.gain);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + atk);
    amp.gain.setValueAtTime(peak, t0 + o.dur * 0.5);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    (o.formants || []).forEach((fr) => {
      const f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = fr.q || 6;
      f.frequency.setValueAtTime(fr.f0, t0);
      f.frequency.linearRampToValueAtTime(fr.f1 == null ? fr.f0 : fr.f1, t0 + o.dur);
      const g = c.createGain();
      g.gain.value = fr.g == null ? 0.4 : fr.g;
      osc.connect(f);
      f.connect(g);
      g.connect(amp);
    });

    // 基频直通：只走共振峰的话，F0 的能量会被高 Q 带通削掉大半，
    // 出来是「嗡嗡的滤波声」而不是「有人在哼」—— 底气全靠这条路。
    if (o.raw) {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.rawF || 1100;
      lp.Q.value = 1;
      const rg = c.createGain();
      rg.gain.value = o.raw;
      osc.connect(lp);
      lp.connect(rg);
      rg.connect(amp);
    }

    amp.connect(bus(c));
    sendTo(c, amp, o.send);

    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
    lfo.start(t0);
    lfo.stop(t0 + o.dur + 0.05);
  }

  /* ================= 真实录音样本（用户提供的 mp3） ================= */

  const SAMPLE_TARGET_RMS = 0.055;  // 响度对齐目标（和合成音的档位一致）
  const SAMPLE_PEAK_CAP = 0.85;     // 对齐后再压一道峰值保险

  /**
   * 素材裁剪表：name -> { start, dur, fade }（秒）。
   *
   * 给某段素材只播一部分用。做法是解码整条 buffer，播放时
   * 用 `start(0, offset, duration)` 取窗口 —— 不重新编码，
   * 原始文件保持完整，口径随时可调（后续想换回三口只改这里的数字）。
   *
   * coffee（加血.mp3）：原始录音是「连吞三口口水」（包络实测三记在
   * 0.17-0.37s / 1.03-1.17s / 1.93-2.05s，共 2.32s）。
   * 用户要求只留一口 → 取第一记 0.15s 起、0.27s 长（0.15-0.42s），
   * 尾端 30ms 淡出收干净那记「咕咚」的余韵，不硬切（硬切是「啪」的一声）。
   */
  const SAMPLE_TRIM = {
    coffee: { start: 0.15, dur: 0.27, fade: 0.03 }
  };

  const samples = {};     // name -> { buf, gain, start, dur, fade }
  let samplesAsked = false;

  function b64ToBuf(b64) {
    const bin = global.atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  /**
   * 解码三段 mp3 并自动做响度对齐。
   * 素材间响度差 6 倍以上（加血 RMS 0.02 / 鞭子 0.14），不拉齐的话
   * 换个道具音量就跳一大截。对齐基准是 RMS（人耳感知响度），不是峰值 ——
   * 真实录音动态大，按峰值对齐会显得整体偏轻。
   *
   * 裁剪过的素材只在**播放窗口内**算 RMS：拿整条含静音的平均值去对齐，
   * 会把「只播一小段」的素材算得过响（静音把 RMS 拉低，补回来的增益就虚高）。
   */
  function loadSamples() {
    if (samplesAsked) return;
    samplesAsked = true;
    const src = global.SFX_SAMPLES;
    if (!src || !global.atob) return;
    const c = ac();
    if (!c || !c.decodeAudioData) return;
    Object.keys(src).forEach((k) => {
      try {
        const ab = b64ToBuf(src[k]);
        const absorb = (buf) => {
          if (!buf || !buf.length) return;
          const tr = SAMPLE_TRIM[k] || null;
          const start = tr && tr.start ? Math.min(tr.start, buf.duration) : 0;
          const dur = tr && tr.dur
            ? Math.min(tr.dur, buf.duration - start)
            : buf.duration - start;
          const i0 = Math.floor(start * buf.sampleRate);
          const i1 = Math.min(buf.length, Math.floor((start + dur) * buf.sampleRate));
          // RMS + 峰值（只统计播放窗口）
          let sum = 0, peak = 0;
          for (let ch = 0; ch < buf.numberOfChannels; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = i0; i < i1; i++) {
              const v = d[i];
              sum += v * v;
              const a = v < 0 ? -v : v;
              if (a > peak) peak = a;
            }
          }
          const rms = Math.sqrt(sum / Math.max(1, (i1 - i0) * buf.numberOfChannels));
          const gain = Math.min(SAMPLE_TARGET_RMS / Math.max(rms, 1e-6), SAMPLE_PEAK_CAP / Math.max(peak, 1e-6));
          samples[k] = {
            buf,
            gain: Math.max(0.05, gain),
            start,
            dur,
            fade: tr && tr.fade ? tr.fade : 0.012
          };
        };
        const r = c.decodeAudioData(ab, absorb, () => {});
        if (r && r.then) r.then(absorb).catch(() => {});
      } catch (e) { /* 单个素材坏了不影响其它 */ }
    });
  }

  /** 播放一段已解码的素材（按裁剪窗口取片段）。素材没就绪时返回 false，调用方回落到合成。 */
  function playSample(name) {
    const s = samples[name];
    if (!s) return false;
    const c = ac();
    if (!c) return false;
    try {
      const t0 = c.currentTime;
      const dur = s.dur || s.buf.duration - (s.start || 0);
      const src = c.createBufferSource();
      src.buffer = s.buf;
      const g = c.createGain();
      g.gain.setValueAtTime(s.gain, t0);
      // 尾端淡出：截断处（以及素材本身收得干脆时）不留「啪」的爆点。
      // 淡出长度默认 12ms，够短，听不出音量变化，但足够把切口糊掉。
      const f = Math.max(0.008, Math.min(s.fade || 0.012, dur * 0.5));
      g.gain.setValueAtTime(s.gain, t0 + Math.max(0, dur - f));
      g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
      src.connect(g);
      g.connect(bus(c));   // 走总线：共享限幅器，连打重叠也不会爆
      src.start(t0, s.start || 0, dur);
      src.stop(t0 + dur + 0.01);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ================= 枪声（手枪 / 加特林共用发声体） ================= */

  /**
   * 一发射击。
   *
   * 真枪的听感由三段构成：① 亚毫秒的超声爆音 ② 低频膛音/冲击波 ③ 空间余响。
   * 少了 ① 就是「放气」，少了 ③ 就是「电子枪」，三段齐了才像枪。
   *
   * 早反射（三次离散回声）是空间感的真正来源 —— 光靠混响只有「糊」，
   * 有离散回声才听得出墙在哪里。
   *
   * 手枪和加特林共用这个发声体，区别在**触发方式**：
   * 手枪一次一发；加特林把它以 42ms 间隔连按 8 次。单发和连击是两种听感，
   * 不需要为加特林另造一套音色。
   */
  function gunShot(c, o) {
    const at = o.at || 0;
    const k = o.gain == null ? 1 : o.gain;
    // ① 超声爆音：亚毫秒起振 —— 「是枪」还是「是放气」的分界线
    layer(c, { type: 'highpass', f0: 3800, q: 0.5, gain: 0.95 * k, atk: 0.0004, dur: 0.009, at, send: 0.10 });
    // ② 炸裂主体：中高频往下扫，给爆音「厚度」
    layer(c, { type: 'bandpass', f0: 2400, f1: 900, q: 0.7, sweep: 0.09, gain: 0.72 * k, atk: 0.0006, dur: 0.075, at, send: 0.20 });
    // ③ 膛音/冲击波：低频气团，决定这把枪听起来「大不大」
    layer(c, { type: 'lowpass', f0: 330, f1: 170, q: 1.0, sweep: 0.24, gain: 0.70 * k, atk: 0.0012, dur: 0.25, at, send: 0.22 });
    // ④ 极低频下坠：量感
    body(c, { at, f0: 165, f1: 38, dur: 0.30, gain: 0.55 * k, atk: 0.0008, wave: 'sine', send: 0.18 });
    // ⑤ 早反射：音量递减、高频被吃掉更多 —— 连发时省掉，交给总尾音
    if (o.echo !== false) {
      [[0.036, 0.30, 1500], [0.079, 0.19, 1000], [0.138, 0.12, 700]].forEach((e) => {
        layer(c, { type: 'lowpass', f0: e[2], q: 0.6, gain: e[1] * k, atk: 0.002, dur: 0.05, at: at + e[0] });
      });
    }
    if (o.tail !== false) {
      layer(c, {
        type: 'lowpass', f0: 900, f1: 420, q: 0.5, sweep: 0.5,
        gain: 0.12 * k, atk: 0.03, dur: 0.55, at: at + 0.02, send: 0.30
      });
    }
  }

  /* ================= 音效表 ================= */

  const SFX = {
    /**
     * 皮鞭：改播用户提供的真实录音（两记抽打 + 余音，1.46s）。
     * 素材没就绪/解码失败时回落到下面的合成版 —— 永远有声音。
     */
    whip() {
      if (playSample('whip')) return;
      const c = ac(); if (!c) return; bus(c);
      // ① 鞭梢破空：超短高频爆破，整段音最尖的那一下
      layer(c, { type: 'highpass', f0: 3200, q: 0.6, gain: 0.95, atk: 0.0004, dur: 0.018, send: 0.12 });
      layer(c, { type: 'bandpass', f0: 4800, q: 1.4, gain: 0.55, atk: 0.0004, dur: 0.024, send: 0.10 });
      // ② 抽在皮肉上的「啪」：1750 → 780Hz 快速下落的中频冲击
      layer(c, { type: 'bandpass', f0: 1750, f1: 780, q: 0.9, sweep: 0.055, gain: 0.78, atk: 0.0006, dur: 0.065, send: 0.16 });
      // ③ 肉响：低频闷下去 —— 「抽」和「甩」的区别就在这一层
      layer(c, { type: 'lowpass', f0: 420, f1: 190, q: 1.0, sweep: 0.10, gain: 0.55, atk: 0.0012, dur: 0.13, send: 0.14 });
      body(c, { f0: 205, f1: 78, dur: 0.115, gain: 0.38, atk: 0.0015, wave: 'sine', send: 0.10 });
      // ④ 挥动的气流：噪声从低往上扫，骑在爆点后面
      layer(c, { type: 'bandpass', f0: 800, f1: 3000, q: 1.1, sweep: 0.13, gain: 0.24, atk: 0.022, dur: 0.17, at: 0.02, send: 0.22 });
    },

    /**
     * 水枪：核心是那记「biu」——水柱被压出去的一瞬间。
     * 「在喷水」和「射出去」的分界线就是音高：光有噪声嘶声永远只是喷雾，
     * 加一条先上冲再回落的音高线，耳朵才会听成「射出去了」。
     */
    water() {
      const c = ac(); if (!c) return; bus(c);
      // ① biu 的上冲段：260 → 1500Hz，45ms 冲完 —— 水柱出膛
      body(c, { f0: 260, f1: 1500, sweep: 0.045, dur: 0.055, gain: 0.36, atk: 0.002, wave: 'triangle', send: 0.10 });
      // ② biu 的回落段：1800 → 520Hz —— 水柱散开、速度掉下来
      body(c, { at: 0.045, f0: 1800, f1: 520, sweep: 0.085, dur: 0.095, gain: 0.28, atk: 0.003, wave: 'sine', send: 0.12 });
      // ③ 出水的瞬态爆点
      layer(c, { type: 'highpass', f0: 2200, q: 0.7, gain: 0.42, atk: 0.0008, dur: 0.028, send: 0.08 });
      // ④ 水柱/喷雾的宽频嘶声，跟着 biu 一起往下扫
      layer(c, { type: 'bandpass', f0: 3200, f1: 1300, q: 0.7, sweep: 0.30, gain: 0.42, atk: 0.008, dur: 0.32, send: 0.16 });
      // ⑤ 雾化的低频底噪（水柱粗的部分）
      layer(c, { type: 'lowpass', f0: 950, q: 0.6, gain: 0.22, atk: 0.02, dur: 0.30, send: 0.12 });
      // ⑥ 零星水珠：随机时间点的极短打点，随机感是「湿」的关键
      for (let i = 0; i < 4; i++) {
        layer(c, {
          type: 'bandpass', f0: 2600 + Math.random() * 2600, q: 2.2,
          gain: 0.09 + Math.random() * 0.07, atk: 0.0008,
          dur: 0.010 + Math.random() * 0.014, at: 0.07 + Math.random() * 0.24, send: 0.10
        });
      }
      // ⑦ 塑料枪身的空腔共振，压得很低，只在开头垫一下
      body(c, { f0: 190, f1: 120, dur: 0.16, gain: 0.09, atk: 0.006, wave: 'sine', send: 0.06 });
    },

    /** 手枪：单发，完整三段 + 三次早反射 */
    gun() {
      const c = ac(); if (!c) return; bus(c);
      gunShot(c, { at: 0 });
    },

    /**
     * 加特林：多重手枪连击。
     * 转管电机先转起来（连续底噪），然后 42ms 一发连按 8 次 —— 末几发略轻，
     * 像转速回落；最后补一记总尾音，连射把空间填满的感觉就出来了。
     */
    gatling() {
      const c = ac(); if (!c) return; bus(c);
      // 转管电机：带通在 420→700Hz 之间游走，给连射垫一层「机械感」
      layer(c, { type: 'bandpass', f0: 420, f1: 700, q: 2.5, sweep: 0.36, gain: 0.10, atk: 0.03, dur: 0.36, send: 0.12 });
      for (let i = 0; i < 8; i++) {
        // 单发压到 0.37：8 发在 42ms 间隔里是叠着的（每发响 250ms+），
        // 峰值会叠到 0.4 左右 —— 比手枪（0.26）明显更猛但不炸耳。
        // 直接照搬手枪的 1.0 会叠到 0.58，比所有音效高 7dB，太突。
        gunShot(c, {
          at: i * 0.042 + (i ? Math.random() * 0.006 : 0),
          gain: 0.37 * (1 - i / 20),
          echo: false,   // 连发时每发都带三次回声会糊成一团
          tail: false    // 尾音由最后统一补一层
        });
      }
      layer(c, { type: 'lowpass', f0: 800, f1: 380, q: 0.5, sweep: 0.45, gain: 0.13, atk: 0.04, dur: 0.55, at: 0.36, send: 0.30 });
    },

    /**
     * 雷电：放电（啪）+ 炸裂（爆）+ 低频冲击（轰）+ 四层隆隆滚动（鸣）。
     * 「闪电」和「雷」是两件事，必须分开：
     *   闪电 = 空气被击穿的一簇极短火花，高频、碎、时间集中在最前面几十毫秒
     *   雷   = 爆炸 + 轰鸣，低频，拖到一秒以上
     * 只做雷没有「电」的锐利感，只做电没有威压感。
     */
    thunder() {
      const c = ac(); if (!c) return; bus(c);
      // ① 闪电放电：一簇极短的宽带火花（击穿空气）
      for (let i = 0; i < 14; i++) {
        layer(c, {
          type: 'highpass', f0: 2600 + Math.random() * 3800, q: 0.8,
          gain: 0.09 + Math.random() * 0.11, atk: 0.0004,
          dur: 0.006 + Math.random() * 0.014,
          at: 0.004 + Math.random() * 0.18, send: 0.26
        });
      }
      // ② 炸裂（爆）
      layer(c, { type: 'highpass', f0: 1800, q: 0.5, gain: 0.95, atk: 0.0005, dur: 0.09, send: 0.22 });
      layer(c, { type: 'bandpass', f0: 3200, f1: 1200, q: 0.7, sweep: 0.12, gain: 0.55, atk: 0.0006, dur: 0.10, send: 0.18 });
      // ③ 爆炸的低频冲击（轰）：350 → 90Hz 扫下去，这才是「炸」不是「啪」
      layer(c, { type: 'lowpass', f0: 350, f1: 90, q: 1.1, sweep: 0.45, gain: 0.80, atk: 0.002, dur: 0.60, send: 0.30 });
      body(c, { f0: 110, f1: 28, dur: 0.75, gain: 0.62, atk: 0.002, wave: 'sine', send: 0.28 });
      // ④ 四层隆隆（鸣）：错开进入 + 各自衰减不同 → 拍频出「滚」的起伏
      layer(c, { type: 'lowpass', f0: 150, q: 0.7, gain: 0.34, atk: 0.06, dur: 0.90, at: 0.08, send: 0.34 });
      layer(c, { type: 'lowpass', f0: 115, q: 0.7, gain: 0.30, atk: 0.10, dur: 1.15, at: 0.20, send: 0.36 });
      layer(c, { type: 'lowpass', f0: 90, q: 0.7, gain: 0.26, atk: 0.15, dur: 1.35, at: 0.38, send: 0.36 });
      layer(c, { type: 'lowpass', f0: 70, q: 0.7, gain: 0.22, atk: 0.20, dur: 1.55, at: 0.60, send: 0.36 });
    },

    /** 呜咽：走人声共振峰 —— 两个音节，音高下落带颤音，尾巴带一点换气声 */
    whimper() {
      const c = ac(); if (!c) return; bus(c);
      voice(c, {
        f0: 430, f1: 330, dur: 0.30, gain: 0.30, atk: 0.035,
        vib: 6.2, vibDepth: 9, send: 0.22, raw: 0.55, rawF: 1100,
        formants: [
          { f0: 700, f1: 400, q: 7, g: 0.50 },
          { f0: 1260, f1: 900, q: 9, g: 0.30 },
          { f0: 2700, f1: 2350, q: 10, g: 0.10 }
        ]
      });
      voice(c, {
        at: 0.19, f0: 355, f1: 250, dur: 0.28, gain: 0.24, atk: 0.045,
        vib: 5.2, vibDepth: 7, send: 0.22, raw: 0.50, rawF: 950,
        formants: [
          { f0: 600, f1: 380, q: 7, g: 0.46 },
          { f0: 1060, f1: 800, q: 9, g: 0.28 },
          { f0: 2500, f1: 2200, q: 10, g: 0.09 }
        ]
      });
      // 换气声：一点点高频气声，人声光有嗡嗡声会像机器人
      layer(c, { type: 'bandpass', f0: 1700, f1: 1000, q: 1.2, gain: 0.030, atk: 0.03, dur: 0.24, at: 0.01, send: 0.12 });
    },

    /** 崩溃：重物砸地的闷响 + 低频下坠 + 四散的碎屑 */
    crash() {
      const c = ac(); if (!c) return; bus(c);
      // ① 撞击瞬态
      layer(c, { type: 'highpass', f0: 1400, q: 0.7, gain: 0.85, atk: 0.0006, dur: 0.022, send: 0.14 });
      layer(c, { type: 'lowpass', f0: 220, q: 0.8, gain: 0.60, atk: 0.002, dur: 0.34, send: 0.24 });
      // ② 低频下坠：从 130Hz 掉到 34Hz，这一层负责「沉」
      body(c, { f0: 130, f1: 34, dur: 0.45, gain: 0.50, atk: 0.002, wave: 'sine', send: 0.22 });
      // ③ 碎屑：随机时间点的短打点，模拟碎片落地
      for (let i = 0; i < 6; i++) {
        layer(c, {
          type: 'bandpass', f0: 700 + Math.random() * 1900, q: 2.4,
          gain: 0.10 + Math.random() * 0.09, atk: 0.0008,
          dur: 0.016 + Math.random() * 0.035, at: 0.06 + Math.random() * 0.50, send: 0.18
        });
      }
      // ④ 扬起的尘土 / 余震
      layer(c, { type: 'lowpass', f0: 320, f1: 170, q: 0.6, sweep: 0.7, gain: 0.18, atk: 0.06, dur: 0.80, at: 0.05, send: 0.30 });
    },

    /** 叮：钟的非谐分音。纯正弦扫频永远不是「叮」，非谐比才是钟的灵魂 */
    ding() {
      const c = ac(); if (!c) return; bus(c);
      const base = 1046;
      // 比例 / 音量 / 衰减时长 —— 高次分音衰减明显更快，这是金属振动的物理事实
      const parts = [
        [1.00, 0.35, 0.90],
        [2.00, 0.20, 0.62],
        [2.76, 0.135, 0.46],
        [5.40, 0.068, 0.28],
        [8.93, 0.034, 0.16]
      ];
      parts.forEach((p) => {
        body(c, { f0: base * p[0], dur: p[2], gain: p[1], atk: 0.0015, wave: 'sine', send: 0.30 });
      });
      // 敲击的那一下：小槌撞金属的瞬态
      layer(c, { type: 'highpass', f0: 4500, q: 0.7, gain: 0.17, atk: 0.0006, dur: 0.018, send: 0.14 });
    },

    /**
     * 拖鞋：改播用户提供的真实录音（单记拍打 + 衰减尾，0.78s）。
     * 下面的合成版（p 送气 + 脆响 + 共振峰 i→a）保留作兜底。
     */
    slipper() {
      if (playSample('slipper')) return;
      const c = ac(); if (!c) return; bus(c);
      // ① 「p」送气：双唇爆开，十几毫秒的高频气声 —— 不写这层就是「ia」不是「pia」
      layer(c, { type: 'highpass', f0: 3000, q: 0.6, gain: 0.85, atk: 0.0004, dur: 0.012, send: 0.05 });
      // ② 拍击脆响：宽带冲击，从 1700Hz 快速落到 850Hz —— 橡胶底接触的那声「crack」
      //    拍打的主体，必须比元音响，否则听感变成「啪…哇」两截
      layer(c, { type: 'bandpass', f0: 1700, f1: 850, q: 0.9, sweep: 0.045, gain: 0.88, atk: 0.0006, dur: 0.050, send: 0.10 });
      // ③ 「ia」元音：共振峰滑动（F1 310→780 张开；F2 2200→1150 落下）—— pia 的灵魂
      //    贴着脆响起振（8ms）、比脆响轻一档、105ms 就收 —— 是尾巴不是主角
      voice(c, {
        at: 0.008, f0: 360, f1: 285, dur: 0.105, gain: 0.22, atk: 0.004,
        vib: 6, vibDepth: 0, send: 0.06, raw: 0.50, rawF: 1200,
        formants: [
          { f0: 310, f1: 780, q: 8, g: 0.50 },    // F1：i 的窄 → a 的开
          { f0: 2200, f1: 1150, q: 9, g: 0.34 },  // F2：i 的高 → a 的低
          { f0: 2900, f1: 2500, q: 10, g: 0.10 }
        ]
      });
      // ④ 肉感：拍在身上那点闷，纯瞬态会显得单薄
      body(c, { f0: 175, f1: 70, dur: 0.090, gain: 0.30, atk: 0.002, wave: 'sine', send: 0.06 });
      // ⑤ 房间：拍打是干的，混响只给一点点 —— 给多了尾音起波纹，听着像在浴室里拍
      layer(c, { type: 'lowpass', f0: 800, f1: 420, q: 0.5, sweep: 0.18, gain: 0.06, atk: 0.010, dur: 0.16, send: 0.10 });
    },

    /**
     * 投喂咖啡：改播用户提供的真实录音。
     * 录音本身是「连吞三口」，按用户要求经 SAMPLE_TRIM 只播第一口（0.27s）。
     * 下面的合成版（一口咕咚 + 暖铃 + 碎光）保留作兜底，口数跟着采样走。
     */
    coffee() {
      if (playSample('coffee')) return;
      const c = ac(); if (!c) return; bus(c);
      // ① 嘴唇碰杯 / 吸一口的气声
      layer(c, { type: 'highpass', f0: 1500, q: 0.6, gain: 0.20, atk: 0.005, dur: 0.10, send: 0.08 });
      // ② 一记咕咚：低沉短促的下坠音高 + 一点水声
      [[0.02, 305, 170, 0.26]].forEach(([at, f0, f1, g]) => {
        body(c, { at, f0, f1, sweep: 0.055, dur: 0.085, gain: g, atk: 0.004, wave: 'sine', send: 0.10 });
        layer(c, { type: 'lowpass', f0: 780, f1: 380, q: 1.2, sweep: 0.06, gain: g * 0.75, atk: 0.004, dur: 0.06, at, send: 0.08 });
      });
      // ③ 加血：两记往上走的暖铃（带钟的非谐分音，但不刺耳）
      [[0.20, 784, 0.20], [0.34, 1175, 0.16]].forEach(([at, f, g]) => {
        body(c, { at, f0: f, dur: 0.45, gain: g, atk: 0.010, wave: 'sine', send: 0.30 });
        body(c, { at, f0: f * 2.01, dur: 0.24, gain: g * 0.28, atk: 0.010, wave: 'sine', send: 0.26 });
        body(c, { at, f0: f * 2.76, dur: 0.15, gain: g * 0.12, atk: 0.008, wave: 'sine', send: 0.22 });
      });
      // ④ 细碎闪光：血量在回升的那种「沙沙的亮」
      for (let i = 0; i < 8; i++) {
        layer(c, {
          type: 'bandpass', f0: 4200 + Math.random() * 3800, q: 6,
          gain: 0.030, atk: 0.002, dur: 0.05 + Math.random() * 0.06,
          at: 0.21 + Math.random() * 0.30, send: 0.26
        });
      }
    }
  };

  global.SFX = {
    setEnabled(v) {
      enabled = !!v;
    },
    /**
     * 预热：App 启动时调一次，把三段 mp3 的解码提前跑掉。
     * 不调的话第一次打击会先落到合成兜底，约 0.2s 后素材才就绪。
     */
    preload() {
      loadSamples();
    },
    /**
     * @param {string} name   音效名
     * @param {number} [after] 延迟多少秒再响（用来做「先砸地、后哭」这种先后关系）
     */
    play(name, after) {
      if (!enabled) return;
      loadSamples();   // 惰性加载：没 preload 过也在第一次播放时补上
      const fire = () => {
        try {
          const fn = SFX[name];
          if (fn) fn();
          global.__SFX_ERR__ = null;
        } catch (e) {
          // 合成失败不能影响抽打主流程，但也不能完全吞掉 —— 留一个诊断出口
          global.__SFX_ERR__ = (e && e.message ? e.message : String(e)) + ' [' + name + ']';
        }
      };
      if (after > 0) setTimeout(fire, after * 1000);
      else fire();
    }
  };
})(window);
