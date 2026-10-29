/**
 * 命中特效层 —— 全屏 Canvas，但**按卡片裁剪**
 *
 * 四类视觉：
 *   1. 拖尾 trail()      —— 鼠标移动留下武器形状的残影，形状随武器而变
 *   2. 甩击 whoosh()     —— 按下时向目标甩出一道弧线
 *   3. 命中 hit()        —— 冲击痕 + 粒子迸溅
 *   4. 闪屏 flash()      —— 命中瞬间整屏一层极淡色闪，连击越高越强
 *
 * 裁剪（clip）：
 *   特效必须只出现在被抽打的那张卡里，不能溅到别的卡、侧栏或顶栏上。
 *   做法是每个效果都带一个 clip矩形（卡片的屏幕坐标），
 *   绘制前用 ctx.rect + clip 限定范围。拖尾只在指针位于某张卡内时才产生。
 *
 * 武器形态（trail 的形状）：
 *   lash  皮鞭  ：弧形细线
 *   wet   水枪  ：水滴圆点串
 *   shot  手枪  ：火花射线
 *   zap   闪电  ：锯齿折线
 *   smack 拖鞋  ：扁椭圆
 *   heal  咖啡  ：上升热气
 *
 * 视频精灵动画（2026-10-12 已停用 —— 用户决定改为程序化特效）：
 *   用户做的即梦武器动画（assets/tools/fx/*.png，内嵌于 fx-meta.js）
 *   保留在代码里，由 SPRITES_ENABLED 一键恢复；当前命中特效全部
 *   走下面的程序化 drawImpact（每种武器贴合自身特征绘制）。
 */
(function (global) {
  'use strict';

  /** 视频精灵动画总开关：true = 命中时播武器视频（旧方案），false = 程序化特效 */
  const SPRITES_ENABLED = false;

  function Effects(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    let parts = [];      // 迸溅粒子
    let trailPts = [];   // 鼠标拖尾点
    let arcs = [];       // 甩击弧
    let floats = [];     // 伤害数字
    let impacts = [];    // 命中特效（每把武器一种，程序化绘制）
    let flashEl = null;  // 闪屏DOM
    let shake = 0;       // 震屏强度
    let raf = null;
    let lastTrailAt = 0;
    // resize 节流用的状态（见 resize 注释）
    let resizeRaf = 0;
    let pendingResize = false;

    /* ---------------- 视频精灵动画 ---------------- */

    const TOOL_FX = global.TOOL_FX || {};
    const anims = [];                          // 正在播的精灵动画
    const sprites = {};                        // tool → {img, ok}

    function spriteFor(tool) {
      const m = TOOL_FX[tool];
      if (!m) return null;
      let e = sprites[tool];
      if (!e) {
        e = sprites[tool] = { img: new Image(), ok: false, broken: false };
        e.img.onload = () => { e.ok = true; };
        e.img.onerror = () => { e.broken = true; };
        e.img.src = m.src;                     // data URI（bundle 内嵌），无路径/时序问题
      }
      return e;
    }
    // 启动即全部预载：首次抽打不等图。
    // 2026-10-13 瘦身：fx-meta.js（约 3MB）从 index.html 移除，改由这里按需
    // 动态注入 —— SPRITES_ENABLED=false（当前默认）时整份脚本完全不加载；
    // 恢复精灵动画只需把上面的开关改回 true，行为与旧版一致。
    function preloadSprites() {
      Object.keys(global.TOOL_FX || {}).forEach(spriteFor);
    }
    if (SPRITES_ENABLED) {
      if (global.TOOL_FX) {
        preloadSprites();
      } else {
        const s = document.createElement('script');
        s.src = ((typeof window !== 'undefined' && window.__ASSET_BASE) || '') + 'assets/tools/fx/fx-meta.js';
        s.onload = preloadSprites;
        s.onerror = () => {};   // 加载失败回落程序化特效，不打断
        document.head.appendChild(s);
      }
    }

    /**
     * 画布尺寸同步。
     *
     * ⚠ 必须节流，这是「拖动窗口时窗口变空白/花屏」的主要根因之一：
     *   一次拖动会触发上百次 resize 事件。如果每次都同步执行下面几行，
     *   就是每帧重新分配一块「窗口宽 × 高 × dpr²」的巨大位图
     *   （Retina 下 1440×900 已经是 2880×1800×4 ≈ 20MB），
     *   同时强制 GPU 重新光栅化整块画布。合成器被压垮 → 掉帧 → 白屏。
     *
     * 所以：rAF 合并（多次事件只落地一次）+ 尺寸没变就不动+
     * 纹理上限保护。
     */
    function resize() {
      pendingResize = true;
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (!pendingResize) return;
        pendingResize = false;
        applyResize();
      });
    }

    /** 画布纹理边长上限：超过这个尺寸部分GPU 会拒绝分配，整块画布直接不渲染 */
    const MAX_TEX = 4096;

    function applyResize() {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      // 特效层在拖动窗口期间是 display:none（见 styles.css 的 body.resizing），
      // 此时尺寸为 0，直接跳过；恢复显示后 resize() 会被重新调用。
      if (!cw || !ch) return;

      // dpr 上限 2：高 DPI 屏上再往上堆像素对观感毫无帮助，只是白白吃显存。
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      // 再按最长边收敛，保证 backing store 不越过 GPU 纹理上限
      const s = Math.min(dpr, MAX_TEX / Math.max(cw, ch));
      const w = Math.round(cw * s);
      const h = Math.round(ch * s);
      // 尺寸一致就别碰 canvas.width —— 赋值会清空画布并重新分配内存
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      ctx.setTransform(s, 0, 0, s, 0, 0);
    }

    function rnd(a, b) {
      return a + Math.random() * (b - a);
    }

    /* ---------------- 裁剪 ---------------- */

    /**
     * 把绘制范围限制在给定矩形内。
     * 没有 clip 时退化为整块画布，保证旧调用方式不受影响。
     */
    function withClip(clip, draw) {
      if (clip && clip.w > 0 && clip.h > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
      }
      draw();
      if (clip && clip.w > 0 && clip.h > 0) ctx.restore();
    }

    /** 把屏幕坐标换算成 canvas 内坐标 */
    function toLocal(clip, x, y) {
      if (!clip) return { x, y };
      return { x: x - clip.x, y: y - clip.y };
    }

    /* ---------------- 鼠标拖尾 ---------------- */

    /**
     * 鼠标拖尾。
     * clip 传 null 表示不产生拖尾（指针不在任何卡片内），
     * 这样鞭痕不会拖到侧栏、顶栏上去。
     */
    function trail(x, y, kind, clip) {
      if (clip === null) return;
      const now = Date.now();
      // 限流：约每 22ms 记一个点，避免帧率低时拖尾过长
      if (now - lastTrailAt < 22) return;
      lastTrailAt = now;
      const lp = toLocal(clip, x, y);
      trailPts.push({
        x: lp.x, y: lp.y, clip,
        kind: kind || 'lash', life: 1, r: rnd(3, 7), seed: Math.random() * 6
      });
      if (trailPts.length > 34) trailPts.shift();
    }

    /** 每种武器一种笔触形状 */
    function drawTrailStroke(p) {
      const px = p.x;
      const py = p.y;
      const a = p.life * p.life;            // 平方衰减，尾端更淡
      ctx.globalAlpha = a * 0.55;

      switch (p.kind) {
        case 'wet': {           // 水滴
          ctx.fillStyle = '#5AA9E6';
          ctx.beginPath();
          ctx.arc(px, py, p.r * 0.75 * a + 0.6, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 'shot': {          // 火花射线
          const ang = p.seed;
          ctx.strokeStyle = '#E0A458';
          ctx.lineWidth = 1.6;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(px - Math.cos(ang) * p.r * 2, py - Math.sin(ang) * p.r * 2);
          ctx.lineTo(px + Math.cos(ang) * p.r * 2, py + Math.sin(ang) * p.r * 2);
          ctx.stroke();
          break;
        }
        case 'zap': {           // 锯齿闪电
          ctx.strokeStyle = '#7C9BE8';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(px - 8, py);
          for (let i = 1; i <= 3; i++) ctx.lineTo(px - 8 + i * 5.3, py + rnd(-4, 4));
          ctx.stroke();
          break;
        }
        case 'smack': {         // 扁椭圆（拖鞋印）
          ctx.strokeStyle = '#C98BA8';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.ellipse(px, py, p.r * 1.7 * a + 2, p.r * 0.7 * a + 1, p.seed, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case 'heal': {          // 上升热气
          ctx.strokeStyle = '#B08A5E';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.quadraticCurveTo(px + 3, py - 4, px, py - 9);
          ctx.stroke();
          break;
        }
        case 'gatling': {       // 曳光弹：粉色小圆 + 短尾
          ctx.fillStyle = '#E86FA4';
          ctx.beginPath();
          ctx.arc(px, py, p.r * 0.6 * a + 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(232,111,164,.45)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(px - 7, py + 2);
          ctx.lineTo(px, py);
          ctx.stroke();
          break;
        }
        case 'touch': {         // 徒手：淡淡粉印（摸摸它，别再拖鞭痕了）
          ctx.fillStyle = 'rgba(238,168,180,.42)';
          ctx.beginPath();
          ctx.arc(px, py, p.r * 0.7 * a + 1, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        default: {              // 皮鞭：弧线
          ctx.strokeStyle = '#8A6A44';
          ctx.lineWidth = 2.2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(px, py, p.r * 2.2 * a + 3, Math.PI * 0.15, Math.PI * 0.95);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    /* ---------------- 甩击弧 ---------------- */

    function whoosh(x, y, kind, clip) {
      if (clip === null) return;
      const lp = toLocal(clip, x, y);
      arcs.push({ x: lp.x, y: lp.y, clip, kind, life: 12, max: 12, ang: rnd(-0.5, 0.5) });
      if (arcs.length > 6) arcs.shift();
    }

    function drawArc(a) {
      const t = 1 - a.life / a.max;
      const R = 46 + t * 78;
      ctx.globalAlpha = (1 - t) * 0.7;
      ctx.strokeStyle = a.kind === 'wet' ? '#5AA9E6' : a.kind === 'zap' ? '#7C9BE8' : a.kind === 'gatling' ? '#E86FA4' : '#B99A6E';
      ctx.lineWidth = 3.4 * (1 - t) + 0.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(a.x, a.y, R, a.ang - 0.8, a.ang + 0.8);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* ---------------- 命中迸溅 ---------------- */

    function spawn(kind, x, y, power, clip) {
      const n = Math.round(14 + 22 * (power || 1));
      for (let i = 0; i < n; i++) {
        let p;
        switch (kind) {
          case 'wet':
            p = { x: x + rnd(-6, 6), y: y + rnd(-6, 6), vx: rnd(-3.4, 3.4), vy: rnd(-4.2, -0.4), g: 0.16, life: rnd(30, 62), r: rnd(2, 6), c: ['#5AA9E6', '#9FD0F0', '#3D8CC4'][i % 3] };
            break;
          case 'shot':
            p = { x, y, vx: rnd(-6.5, 6.5), vy: rnd(-6.5, 2), g: 0.22, life: rnd(22, 46), r: rnd(1.6, 4.4), c: ['#E8B87A', '#D98A5A', '#FFF0C9'][i % 3] };
            break;
          case 'zap':
            p = { x, y, vx: rnd(-5.5, 5.5), vy: rnd(-5.5, 5.5), g: 0, life: rnd(16, 34), r: rnd(1.4, 3.4), c: ['#FFF0C9', '#FFFFFF', '#9FB6F0'][i % 3] };
            break;
          case 'smack':
            p = { x, y, vx: rnd(-5, 5), vy: rnd(-5, 1), g: 0.2, life: rnd(24, 48), r: rnd(2, 5), c: ['#E3A8C4', '#FFF0C9', '#C97E9E'][i % 3] };
            break;
          case 'heal':
            p = { x: x + rnd(-14, 14), y: y + rnd(-6, 14), vx: rnd(-0.8, 0.8), vy: rnd(-1.8, -0.7), g: -0.008, life: rnd(50, 88), r: rnd(2, 5), c: ['#C98BA8', '#E8C4D8', '#FFF0C9'][i % 3] };
            break;
          case 'gatling':
            p = { x, y, vx: rnd(-7, 7), vy: rnd(-6.5, 1.5), g: 0.24, life: rnd(16, 34), r: rnd(1.2, 3), c: ['#FFD27A', '#FF9F5A', '#FFF0C9'][i % 3] };
            break;
          case 'touch':
            p = { x: x + rnd(-10, 10), y: y + rnd(-6, 10), vx: rnd(-0.7, 0.7), vy: rnd(-1.4, -0.5), g: -0.006, life: rnd(36, 64), r: rnd(1.6, 3.4), c: ['#F7CDD6', '#F0B7C2', '#FFF0F2'][i % 3] };
            break;
          default:
            p = { x, y, vx: rnd(-7, 7), vy: rnd(-3.2, 1.6), g: 0.18, life: rnd(20, 42), r: rnd(1.6, 4.4), c: ['#8A6A44', '#B9946A', '#C1553E'][i % 3] };
        }
        p.clip = clip;
        parts.push(p);
      }
      if (parts.length > 900) parts.splice(0, parts.length - 900);
    }

    /* ---------------- 命中特效（程序化，贴合每种道具特征） ----------------
     * 每种武器 = 一段独立的小动画（impacts 队列，命中即入队）：
     *   lash  皮鞭  ：白色弧形鞭痕 + 红芯，快进快出
     *   wet   水枪  ：双层水环涟漪 + 八向拉长水珠
     *   shot  手枪  ：四芒枪口星 + 上飘烟圈
     *   gatling 加特林：弹着点小孔迸火花 + 曳光短线（多点错峰）
     *   zap   雷罚  ：从天而降的折线闪电 + 电环余韵
     *   smack 拖鞋  ：鞋底印「啪」地盖下来（1.3→1 缩放）+ 粉尘
     *   heal  咖啡  ：暖光 + 上升爱心 + 蒸汽卷
     *   touch 徒手  ：软软的掌印环 + 小星点
     */

    // 每种特效的生命帧数（60fps 下约 0.15s ~ 0.6s）
    const IMPACT_FRAMES = {
      lash: 10, wet: 24, shot: 16, gatling: 20,
      zap: 18, smack: 28, heal: 40, touch: 22
    };

    /** 画一颗爱心（heal 用） */
    function heartPath(x, y, s) {
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.75);
      ctx.bezierCurveTo(x - s * 1.15, y - s * 0.35, x - s * 0.5, y - s * 1.05, x, y - s * 0.3);
      ctx.bezierCurveTo(x + s * 0.5, y - s * 1.05, x + s * 1.15, y - s * 0.35, x, y + s * 0.75);
      ctx.closePath();
    }

    function drawImpact(im) {
      const t = 1 - im.life / im.max;   // 0 = 刚命中 → 1 = 消散
      const x = im.x, y = im.y, p = im.power;
      const a = 1 - t;

      switch (im.kind) {
        case 'lash': {                  // 皮鞭：经典鞭痕
          ctx.globalAlpha = Math.min(1, a * 1.8) * 0.95;
          ctx.strokeStyle = '#FFF';
          ctx.lineWidth = 7 * a + 1;
          ctx.lineCap = 'round';
          ctx.shadowColor = 'rgba(193,85,62,.9)';
          ctx.shadowBlur = 20;
          ctx.beginPath();
          ctx.moveTo(x - 76 * p, y - 36 * p);
          ctx.quadraticCurveTo(x, y + 14 * p, x + 80 * p, y - 32 * p);
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = '#C1553E';
          ctx.lineWidth = 3;
          ctx.stroke();
          break;
        }

        case 'wet': {                   // 水枪：涟漪 + 飞珠
          for (let i = 0; i < 2; i++) {
            const tt = t - i * 0.22;
            if (tt < 0 || tt > 1) continue;
            ctx.globalAlpha = (1 - tt) * 0.6;
            ctx.strokeStyle = i ? '#BFE3F7' : '#5AA9E6';
            ctx.lineWidth = 3 * (1 - tt) + 0.8;
            ctx.beginPath();
            ctx.arc(x, y, 8 + tt * 64 * p, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = '#7FBEED';
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2 + im.seed;
            const d = 14 + t * 56 * p;
            ctx.globalAlpha = a * 0.85;
            ctx.beginPath();
            ctx.ellipse(x + Math.cos(ang) * d, y + Math.sin(ang) * d - t * t * 10,
              2.8 * a + 0.8, 4.6 * a + 1, ang, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }

        case 'shot': {                  // 手枪：枪口星 + 烟
          ctx.globalAlpha = Math.min(1, a * 2.2);
          ctx.fillStyle = '#FFE9A8';
          ctx.beginPath();
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2 + 0.4;
            const r = i % 2 === 0 ? (36 - t * 22) * p : 13 - t * 7;
            const px = x + Math.cos(ang) * r, py = y + Math.sin(ang) * r;
            if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = a * 0.35;
          ctx.strokeStyle = '#A79C8E';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y - 10 - t * 26, 6 + t * 14, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }

        case 'gatling': {               // 加特林：弹着点迸花 + 曳光
          for (let i = 0; i < 4; i++) {
            // 每个弹孔有自己的出现时刻，错峰连打
            const t0 = i * 0.16;
            if (t < t0) continue;
            const tt = (t - t0) / (1 - t0);
            const ang = im.seed + i * 1.7;
            const bx = x + Math.cos(ang) * (10 + i * 9) * p;
            const by = y + Math.sin(ang) * (8 + i * 7) * p;
            ctx.globalAlpha = (1 - tt) * 0.95;
            ctx.fillStyle = i % 2 ? '#FFD27A' : '#FF9F5A';
            ctx.beginPath();
            ctx.arc(bx, by, 3.4 * (1 - tt) + 0.8, 0, Math.PI * 2);
            ctx.fill();
            // 进溅的短线
            ctx.strokeStyle = '#FFE2B0';
            ctx.lineWidth = 1.3;
            for (let k = 0; k < 4; k++) {
              const sa = k * Math.PI / 2 + i;
              ctx.beginPath();
              ctx.moveTo(bx, by);
              ctx.lineTo(bx + Math.cos(sa) * (10 - tt * 6), by + Math.sin(sa) * (10 - tt * 6));
              ctx.stroke();
            }
          }
          break;
        }

        case 'zap': {                   // 雷罚：落雷 + 电环
          if (t < 0.55) {
            // 闪电主干：从上方劈到命中点
            const tt = t / 0.55;
            ctx.globalAlpha = 1 - tt * 0.4;
            ctx.strokeStyle = '#FFF8DC';
            ctx.lineWidth = 4.5 * (1 - tt) + 1;
            ctx.shadowColor = '#7C9BE8';
            ctx.shadowBlur = 26;
            ctx.beginPath();
            ctx.moveTo(x + (im.seed % 20 - 10), y - 120);
            let px = x + (im.seed % 20 - 10), py = y - 120;
            for (let i = 1; i <= 6; i++) {
              px = x + (im.seed % 26 - 13) * (1 - i / 6) + Math.sin(i * 5 + im.seed) * 16 * (1 - tt);
              py = y - 120 + (120 / 6) * i * tt;
              ctx.lineTo(px, py);
            }
            ctx.lineTo(x, y);
            ctx.stroke();
            ctx.shadowBlur = 0;
          }
          // 电环余韵
          ctx.globalAlpha = a * 0.7;
          ctx.strokeStyle = '#9FB6F0';
          ctx.lineWidth = 2.4 * a + 0.6;
          ctx.beginPath();
          ctx.arc(x, y, 10 + t * 52 * p, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }

        case 'smack': {                 // 拖鞋：鞋底印盖下来
          const pop = 1.35 - Math.min(1, t * 5) * 0.35;   // 1.35 → 1 啪地砸下
          ctx.globalAlpha = Math.min(1, a * 1.9) * 0.85;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(im.seed - 0.4);
          ctx.scale(pop, pop);
          ctx.fillStyle = 'rgba(255,240,201,.8)';
          ctx.beginPath();
          ctx.ellipse(0, 0, 34 * p, 52 * p, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#C98BA8';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.ellipse(0, 0, 34 * p, 52 * p, 0, 0, Math.PI * 2);
          ctx.stroke();
          // 鞋面带
          ctx.beginPath();
          ctx.arc(0, -30 * p, 20 * p, 0.2, Math.PI - 0.2);
          ctx.stroke();
          ctx.restore();
          break;
        }

        case 'heal': {                  // 咖啡：暖光 + 爱心 + 蒸汽
          const g = ctx.createRadialGradient(x, y, 2, x, y, 60 * p);
          g.addColorStop(0, 'rgba(240,214,170,' + 0.5 * a + ')');
          g.addColorStop(1, 'rgba(220,180,130,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, 60 * p, 0, Math.PI * 2);
          ctx.fill();
          for (let i = 0; i < 3; i++) {
            const tt = (t + i * 0.33) % 1;
            ctx.globalAlpha = (1 - tt) * 0.9;
            ctx.fillStyle = ['#E58BA0', '#F0A8BC', '#D97A92'][i];
            heartPath(x + Math.sin(i * 2.2 + im.seed) * 16, y - tt * 64, (7 - tt * 3) * p);
            ctx.fill();
          }
          // 蒸汽卷
          ctx.globalAlpha = a * 0.5;
          ctx.strokeStyle = '#E8DCC8';
          ctx.lineWidth = 2;
          for (let i = -1; i <= 1; i += 2) {
            ctx.beginPath();
            ctx.moveTo(x + i * 12, y - 6);
            ctx.quadraticCurveTo(x + i * 20, y - 20 - t * 20, x + i * 8, y - 34 - t * 30);
            ctx.stroke();
          }
          break;
        }

        default: {                      // touch 徒手：软掌印环 + 星点
          ctx.globalAlpha = a * 0.8;
          ctx.strokeStyle = '#F0B7C2';
          ctx.lineWidth = 3.4 * a + 0.8;
          ctx.beginPath();
          ctx.arc(x, y, 8 + t * 34, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#F7CDD6';
          for (let i = 0; i < 5; i++) {
            const ang = i / 5 * Math.PI * 2 + im.seed;
            const d = 12 + t * 30;
            ctx.beginPath();
            ctx.arc(x + Math.cos(ang) * d, y + Math.sin(ang) * d, 2 * a + 0.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    /* ---------------- 伤害数字 ---------------- */

    function floatText(text, x, y, color, big, clip) {
      floats.push({ text, x, y, color: color || '#C1553E', clip, life: big ? 54 : 44, vy: big ? -1.5 : -1.1, size: big ? 30 : 20, big: !!big });
      if (floats.length > 20) floats.shift();
    }

    /* ---------------- 闪屏 ---------------- */

    function flash(color, power) {
      if (!flashEl) {
        flashEl = document.createElement('div');
        flashEl.style.cssText =
          'position:fixed;inset:0;pointer-events:none;z-index:380;opacity:0;transition:opacity .34s ease-out';
        document.body.appendChild(flashEl);
      }
      flashEl.style.background =
        'radial-gradient(ellipse at center, transparent 34%, ' + color + ' 130%)';
      flashEl.style.opacity = String(Math.min(0.34, 0.09 + (power || 1) * 0.07));
      setTimeout(() => {
        if (flashEl) flashEl.style.opacity = '0';
      }, 26);
    }

    /* ---------------- 主循环 ---------------- */

    function frame() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);

      // 拖尾
      for (let i = trailPts.length - 1; i >= 0; i--) {
        const p = trailPts[i];
        p.life -= 0.036;
        if (p.life <= 0) {
          trailPts.splice(i, 1);
          continue;
        }
        withClip(p.clip, () => drawTrailStroke(p));
      }

      // 甩击弧
      for (let i = arcs.length - 1; i >= 0; i--) {
        const a = arcs[i];
        a.life--;
        if (a.life <= 0) {
          arcs.splice(i, 1);
          continue;
        }
        withClip(a.clip, () => drawArc(a));
      }

      // 命中特效（每把武器一种，程序化绘制）
      for (let i = impacts.length - 1; i >= 0; i--) {
        const im = impacts[i];
        im.life--;
        if (im.life <= 0) {
          impacts.splice(i, 1);
          continue;
        }
        withClip(im.clip, () => drawImpact(im));
        ctx.globalAlpha = 1;
      }

      // 视频精灵动画（在粒子之上、伤害数字之下）
      for (let i = anims.length - 1; i >= 0; i--) {
        const an = anims[i];
        const m = TOOL_FX[an.tool];
        const e = sprites[an.tool];
        if (!e || e.broken) {
          anims.splice(i, 1);
          continue;
        }
        if (!e.ok) continue;                 // 图还在解码：本帧跳过，动画不丢
        if (an.start === null) an.start = performance.now();
        const idx = Math.floor(((performance.now() - an.start) / 1000) * m.fps);
        if (idx >= m.count) {
          anims.splice(i, 1);
          continue;
        }
        const r = Math.floor(idx / m.cols);
        const c = idx % m.cols;
        const w = m.fw * an.scale;
        const h = m.fh * an.scale;
        withClip(an.clip, () => {
          ctx.drawImage(
            sprites[an.tool].img,
            c * m.fw, r * m.fh, m.fw, m.fh,
            an.x - w / 2, an.y - h * 0.55, w, h
          );
        });
      }

      // 迸溅粒子
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.life--;
        if (p.life <= 0 || p.y > h + 40) {
          parts.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
        ctx.fillStyle = p.c;
        withClip(p.clip, () => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      ctx.globalAlpha = 1;

      // 伤害数字（等宽，描边保证任何背景上都可读）
      ctx.textAlign = 'center';
      for (let i = floats.length - 1; i >= 0; i--) {
        const s = floats[i];
        s.life--;
        s.y += s.vy;
        if (s.life <= 0) {
          floats.splice(i, 1);
          continue;
        }
        const t = s.life / (s.big ? 54 : 44);
        ctx.globalAlpha = Math.min(1, t * 1.7);
        // 起手放大一点，落地回正
        const pop = s.life > (s.big ? 48 : 38) ? 1.28 : 1;
        const px = s.big ? s.size * pop : s.size;
        ctx.font =
          (s.big ? 800 : 700) + ' ' + px.toFixed(0) + 'px "SF Mono", ui-monospace, Menlo, monospace';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(255,253,251,.92)';
        withClip(s.clip, () => {
          ctx.strokeText(s.text, s.x, s.y);
          ctx.fillStyle = s.color;
          ctx.fillText(s.text, s.x, s.y);
        });
      }
      ctx.globalAlpha = 1;

      //按需续帧：屏幕上没有任何东西时就彻底停掉，不要空转。
      //
      // 为什么必须停（这是「拖动窗口时窗口空白/乱码」最直接的根因）：
      //   frame() 开头无条件 ctx.clearRect(0, 0, w, h) —— 那是**每帧清空并
      //   重绘一整块全屏 canvas**。哪怕 parts/trail/arcs/floats 全空、
      //   一个像素都没画，也照样每 16ms 触发一次全窗口尺寸的
      //   clear + 合成 + 上传。窗口 resize 期间合成器本来就在满负荷，
      //   再叠上这个常驻负载，macOS 会直接放弃等待渲染进程，
      //   窗口就变成白底/花屏 —— 正是用户截图里的现象。
      //   特效本来只在「抽打 / 移动鼠标」时才出现，绝大多数时间是静止的，
      //   停掉完全无感知，却能把拖动时的渲染压力降到一个量级以下。
      if (parts.length || trailPts.length || arcs.length || floats.length || anims.length || impacts.length) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = null;
      }
    }

    /** 确保主循环在跑（任何特效开始时调用） */
    function ensureRunning() {
      if (raf === null) raf = requestAnimationFrame(frame);
    }

    function start() {
      ensureRunning();
    }

    function stop() {
      cancelAnimationFrame(raf);
      raf = null;
    }

    return {
      resize,
      start,
      stop,
      // trail / whoosh 用包装函数包了一层：
      // 主循环现在是「按需运行」的（没特效就停帧），
      // 所以每一次产生特效都必须显式唤醒，否则画面不会更新。
      trail: function () {
        ensureRunning();
        return trail.apply(null, arguments);
      },
      whoosh: function () {
        ensureRunning();
        return whoosh.apply(null, arguments);
      },
      flash,
      /**
       * 命中特效。
       * @param clip 卡片矩形（窗口绝对坐标）。传 null 表示不产生效果。
       * @param tool 武器 id（可选）。有视频精灵图 → 播精灵动画替代冲击痕+粒子。
       * 坐标 x/y 为窗口绝对坐标，内部会换算到画布坐标。
       */
      hit(x, y, kind, power, clip, tool) {
        if (clip === null) return;
        ensureRunning();
        const lp = toLocal(clip, x, y);
        // 视频精灵动画：SPRITES_ENABLED=false 时永久走程序化特效（2026-10-12 用户决定），
        // 代码与 bundle 保留，改一个常量即可恢复。
        const sp = SPRITES_ENABLED && tool ? spriteFor(tool) : null;
        if (sp && !sp.broken) {
          const m = TOOL_FX[tool];
          const scale = Math.min(1.15, (clip.h * 0.92) / m.fh);
          anims.push({ tool, x: lp.x, y: lp.y, clip, scale, start: null });
          if (anims.length > 3) anims.shift();
          if (opts.shake !== false) shake = Math.min(1.4, (power || 1) * 0.7);
          return;
        }
        // 程序化命中特效：入队（绘制贴合武器特征，见 drawImpact）
        impacts.push({
          kind,
          x: lp.x, y: lp.y, clip,
          life: IMPACT_FRAMES[kind] || 12,
          max: IMPACT_FRAMES[kind] || 12,
          power: power || 1,
          seed: Math.random() * Math.PI * 2
        });
        // 队列上限：连击太快时丢最旧的
        if (impacts.length > 6) impacts.shift();
        spawn(kind, lp.x, lp.y, power, clip);
        if (opts.shake !== false) shake = Math.min(1.4, (power || 1) * 0.7);
      },
      text(x, y, t, c, big, clip) {
        if (clip === null) return;
        ensureRunning();
        const lp = toLocal(clip, x, y);
        floatText(t, lp.x, lp.y, c, big, clip);
      },
      /** 连击数文字（居中偏上，打击感更强） */
      combo(x, y, n, clip) {
        if (n < 2 || clip === null) return;
        ensureRunning();
        const lp = toLocal(clip, x, y);
        floatText(n + ' COMBO', lp.x, lp.y, '#B07A1E', true, clip);
      },
      get shakeAmount() {
        return shake;
      },
      /** 主循环是否正在跑（测试与调试用） */
      get running() {
        return raf !== null;
      },
      get busy() {
        return parts.length > 0 || trailPts.length > 0 || anims.length > 0 || impacts.length > 0;
      },
      clear() {
        parts.length = 0;
        trailPts.length = 0;
        arcs.length = 0;
        floats.length = 0;
        anims.length = 0;
        impacts.length = 0;
        shake = 0;
        // 主动清空 = 明确要求「什么都别画了」，直接停帧。
        // 不停的话下一帧会发现数组全空而自行停帧，
        // 但中间这一帧仍是一次无谓的全屏 clearRect。
        if (raf !== null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
      }
    };
  }

  global.Effects = Effects;
})(window);