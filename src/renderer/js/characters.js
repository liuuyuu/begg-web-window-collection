/**
 * 圆润软糖风角色渲染器
 * 纯 SVG 字符串生成，没有任何美术资源依赖 —— 方便你随时改配色和配件。
 */
(function (global) {
  'use strict';

  const C = {};

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------------- 五官（极简描边风） ---------------- */

  // 极简：所有五官只用一种墨色，靠形状区分情绪，不再用白底大眼 + 高光
  const INK = '#171717';

  function eyes(def, state, key) {
    const p = def.palette;
    const dark = INK;
    const variant = def.eyes;

    const down = state === 'down';

    const normalRound = () => `
      <circle cx="74" cy="94" r="8" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="126" cy="94" r="8" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="74" cy="94" r="3" fill="${dark}"/>
      <circle cx="126" cy="94" r="3" fill="${dark}"/>`;

    const focusedRound = () => `
      <circle cx="74" cy="96" r="7" fill="${dark}"/>
      <circle cx="126" cy="96" r="7" fill="${dark}"/>
      <path d="M62 82 L86 79" stroke="${dark}" stroke-width="4" stroke-linecap="round"/>
      <path d="M114 79 L138 82" stroke="${dark}" stroke-width="4" stroke-linecap="round"/>`;

    const scaredRound = () => `
      <circle cx="74" cy="92" r="12" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="126" cy="92" r="12" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="74" cy="92" r="4" fill="${dark}"/>
      <circle cx="126" cy="92" r="4" fill="${dark}"/>`;

    const happyArc = (y) => `
      <path d="M60 ${y} q14 -16 28 0" stroke="${dark}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <path d="M112 ${y} q14 -16 28 0" stroke="${dark}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;

    const deadX = () => `
      <path d="M64 86 L84 104 M84 86 L64 104" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>
      <path d="M116 86 L136 104 M136 86 L116 104" stroke="${dark}" stroke-width="5" stroke-linecap="round"/>`;

    const sleepy = () => `
      <path d="M60 96 q14 -12 28 0" stroke="${dark}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M112 96 q14 -12 28 0" stroke="${dark}" stroke-width="4" fill="none" stroke-linecap="round"/>`;

    // 面甲：极简改成描边框 + 两个点
    const visor = () => `
      <rect x="56" y="84" width="88" height="26" rx="2" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="80" cy="97" r="5" fill="${dark}"><animate attributeName="opacity" values="1;.25;1" dur="2.2s" repeatCount="indefinite"/></circle>
      <circle cx="120" cy="97" r="5" fill="${dark}"><animate attributeName="opacity" values="1;.25;1" dur="2.2s" begin=".4s" repeatCount="indefinite"/></circle>`;

    const visorScared = () => `
      <rect x="54" y="82" width="92" height="30" rx="2" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="80" cy="97" r="9" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="120" cy="97" r="9" fill="none" stroke="${dark}" stroke-width="4"/>
      <circle cx="80" cy="97" r="3.5" fill="#B3261E"/>
      <circle cx="120" cy="97" r="3.5" fill="#B3261E"/>`;

    const slit = () => `
      <path d="M62 90 L86 96 L62 102 Z" fill="none" stroke="${dark}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M138 90 L114 96 L138 102 Z" fill="none" stroke="${dark}" stroke-width="3.5" stroke-linejoin="round"/>
      <circle cx="74" cy="96" r="4" fill="${dark}"/>
      <circle cx="126" cy="96" r="4" fill="${dark}"/>`;

    if (down) return deadX();
    if (state === 'beg') return variant === 'visor' ? visorScared() : variant === 'slit' ? scaredRound() : scaredRound();
    if (state === 'joy') return variant === 'visor' ? visor() : happyArc(96);
    if (state === 'working') {
      if (variant === 'visor') return visor();
      if (variant === 'sleepy') return sleepy();
      if (variant === 'slit') return slit();
      return focusedRound();
    }
    if (variant === 'visor') return visor();
    if (variant === 'sleepy') return sleepy();
    if (variant === 'slit') return slit();
    return normalRound();
  }

  function mouth(state) {
    switch (state) {
      case 'beg':
        return `<ellipse cx="100" cy="140" rx="20" ry="16" fill="#171717"/>
                <ellipse cx="100" cy="150" rx="13" ry="9" fill="#FF9DB6"/>`;
      case 'joy':
        return `<path d="M80 134 q20 24 40 0" stroke="#171717" stroke-width="6" fill="#FF9DB6" stroke-linejoin="round"/>`;
      case 'down':
        return `<path d="M84 140 q8 8 16 0 q8 8 16 0" stroke="#171717" stroke-width="5" fill="none" stroke-linecap="round"/>`;
      case 'working':
        return `<ellipse cx="100" cy="138" rx="9" ry="8" fill="#171717"/>`;
      default:
        return `<path d="M88 136 q12 10 24 0" stroke="#171717" stroke-width="5.5" fill="none" stroke-linecap="round"/>`;
    }
  }

  function accessory(def, key) {
    const p = def.palette;
    switch (def.accessory) {
      case 'halo':
        return `<ellipse cx="100" cy="12" rx="40" ry="12" fill="none" stroke="#171717" stroke-width="7" opacity=".95"/>
                <ellipse cx="100" cy="12" rx="40" ry="12" fill="none" stroke="#171717" stroke-width="2.5" opacity=".8"/>`;
      case 'spark':
        return `<g fill="#171717">
                  <path d="M40 50 l4 12 l12 4 l-12 4 l-4 12 l-4 -12 l-12 -4 l12 -4 Z"/>
                  <path d="M160 66 l3 9 l9 3 l-9 3 l-3 9 l-3 -9 l-9 -3 l9 -3 Z" opacity=".8"/>
                </g>`;
      case 'star':
        return `<path d="M150 34 l7 18 l18 7 l-18 7 l-7 18 l-7 -18 l-18 -7 l18 -7 Z" fill="#171717"/>`;
      case 'horns':
        return `<g fill="#171717">
                  <path d="M62 30 q-6 -20 14 -24 q2 16 -8 26 Z"/>
                  <path d="M138 30 q6 -20 -14 -24 q-2 16 8 26 Z"/>
                </g>`;
      case 'beret':
        return `<g>
                  <ellipse cx="112" cy="30" rx="44" ry="16" fill="#171717" transform="rotate(-12 112 30)"/>
                  <circle cx="140" cy="18" r="6" fill="#171717"/>
                </g>`;
      case 'plug':
        return `<g stroke="#171717" stroke-width="5" fill="none" stroke-linecap="round">
                  <path d="M100 22 q0 -22 22 -26"/>
                </g>
                <rect x="118" y="-8" width="18" height="14" rx="4" fill="#171717" stroke="#171717" stroke-width="3"/>`;
      case 'headphone':
        return `<g>
                  <path d="M30 100 q0 -74 70 -74 q70 0 70 74" fill="none" stroke="#171717" stroke-width="10" stroke-linecap="round"/>
                  <rect x="14" y="96" width="24" height="40" rx="12" fill="#171717"/>
                  <rect x="162" y="96" width="24" height="40" rx="12" fill="#171717"/>
                  <circle cx="26" cy="116" r="6" fill="#171717" opacity=".9"/>
                </g>`;
      case 'crescent':
        return `<path d="M140 24 a30 30 0 1 0 22 40 a26 26 0 1 1 -22 -40 Z" fill="#171717"/>`;
      case 'flower':
        return `<g transform="translate(150 34)">
                  <g fill="#FFF">
                    <circle cx="0" cy="-12" r="9"/><circle cx="11" cy="-4" r="9"/>
                    <circle cx="7" cy="10" r="9"/><circle cx="-7" cy="10" r="9"/><circle cx="-11" cy="-4" r="9"/>
                  </g>
                  <circle cx="0" cy="0" r="7" fill="#171717"/>
                </g>`;
      case 'film':
        return `<g opacity=".9">
                  <rect x="18" y="150" width="164" height="26" rx="8" fill="#171717"/>
                  <g fill="#171717">
                    ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${28 + i * 26}" y="156" width="12" height="14" rx="3"/>`).join('')}
                  </g>
                </g>`;
      case 'swirl':
        return `<g stroke="#FFF" stroke-width="5" fill="none" opacity=".85" stroke-linecap="round">
                  <path d="M60 166 q22 -14 40 0 q18 14 40 0"/>
                  <path d="M66 178 q18 -10 34 0 q16 10 34 0" opacity=".6"/>
                </g>`;
      case 'glassesCase':
      case 'caret':
        return `<g>
                  <rect x="150" y="120" width="9" height="34" rx="2" fill="#171717" opacity=".9">
                    <animate attributeName="opacity" values=".9;.15;.9" dur="1s" repeatCount="indefinite"/>
                  </rect>
                  <rect x="140" y="120" width="9" height="34" rx="2" fill="#171717" opacity=".45"/>
                </g>`;
      case 'badge':
        return `<g>
                  <rect x="116" y="8" width="64" height="26" rx="13" fill="#171717"/>
                  <text x="148" y="26" font-size="13" fill="#171717" text-anchor="middle" font-family="sans-serif" font-weight="bold">WB</text>
                </g>`;
      case 'braces':
        return `<g fill="#171717" font-family="monospace" font-size="22" font-weight="bold" opacity=".9">
                  <text x="116" y="40">&lt;/&gt;</text>
                </g>`;
      default:
        return '';
    }
  }

  function cheeks(def, state) {
    // 极简风：腮红改为两根短横线，不用粉色椭圆
    const strong = state === 'beg' || state === 'joy';
    return `
      <g stroke="#B3261E" stroke-width="2.5" stroke-linecap="round" opacity="${strong ? '.9' : '.45'}">
        <path d="M50 116 L60 116"/>
        <path d="M140 116 L150 116"/>
      </g>`;
  }

  function extras(def, state, rt) {
    // 极简风：不用 emoji，全部用几何线条表达状态
    const out = [];
    const INK = '#171717';

    if (state === 'beg') {
      // 求饶：头顶三道竖线（冷汗）+ 两侧眼泪
      out.push(`
        <g stroke="${INK}" stroke-width="2.5" stroke-linecap="round" opacity=".8">
          <path d="M92 24 v-8 M100 22 v-10 M108 24 v-8"/>
        </g>
        <g fill="${INK}" opacity=".85">
          <path d="M62 108 q4 14 -2 20 q6 2 8 -8 q2 -6 -6 -12 Z"/>
          <path d="M138 108 q4 14 -2 20 q6 2 8 -8 q2 -6 -6 -12 Z"/>
        </g>`);
    }

    if (state === 'down') {
      // 阵亡：头顶三道横线（晕倒）
      out.push(`
        <g stroke="${INK}" stroke-width="2.5" stroke-linecap="round" opacity=".7">
          <path d="M86 18 h28 M90 26 h20 M94 34 h12"/>
        </g>`);
    }

    if (state === 'joy') {
      // 感动：头顶向上箭头
      out.push(`
        <g stroke="${INK}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".85">
          <path d="M100 34 v-16 M92 26 l8 -8 l8 8"/>
        </g>`);
    }

    if (state === 'working') {
      // 搬砖：左上角进度刻度条
      out.push(`
        <g stroke="${INK}" stroke-width="2" stroke-linecap="round" opacity=".5">
          <path d="M150 44 h18 M150 52 h12 M150 60 h18"/>
        </g>`);
    }

    if (rt && rt.stress > 70 && state !== 'down') {
      // 高压：右侧感叹号
      out.push(`
        <g stroke="#B3261E" stroke-width="3" stroke-linecap="round" opacity=".9">
          <path d="M168 74 v14"/>
        </g>
        <circle cx="168" cy="95" r="2" fill="#B3261E"/>`);
    }
    return out.join('');
  }

  /* ---------------- 位图角色（卡通 IP 图，2026-10-10 起） ---------------- */

  /**
   * 14 个内置角色已从「现场画 SVG」整体换成「卡通 IP 位图」（assets/pets/）。
   *
   * 关键设计 —— 位图外层**仍然包一个 <svg>**：
   *   1. styles.css 里所有动画都挂在 `.jelly-body` 组和 `svg.hit` 上
   *      （呼吸 / 受击挤压 / 求饶发抖 / 干活浮动），位图包进同名结构后
   *      这些动作变化**一行 CSS 都不用改就全部继承**；
   *   2. 表情变化用「贴纸叠加层」：位图只有一张静态脸，没法重画五官，
   *      所以求饶=泪滴+冷汗、阵亡=X眼贴纸+绕圈星星、开心=笑眼+腮红、
   *      被打瞬间=hit.png 整图切换（用户自绘，见 jelly-hitimg）。
   *      贴纸自带白底圆片，在任意背景上都读得清。
   *
   * 资产约定（2026-10-13 起运行时读 WebP 瘦身版）：
   *   src/renderer/assets/pets/pet-01.webp … pet-12.webp，方形画布 512×512，
   *   角色占 ~88%，五官位置参考 PET_FACE。
   *   源 PNG 仍保留在同目录作素材源（不进包），换图后跑
   *   `python3 scripts/make-pets-webp.py --force` 重新生成 WebP。
   */

  // 资产目录与脚本文件同级推出（renderer / preview / h5 三种入口都自动正确）
  const PET_BASE = (function () {
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
        return document.currentScript.src.replace(/js\/characters\.js(?:[?#].*)?$/, 'assets/pets/');
      }
    } catch (e) {}
    return 'assets/pets/';
  })();

  // 五官锚点：相对位图包围盒的比例（由 scripts 的锚点标定图人工校准）
  const PET_FACE = {
    eye: { x: 0.475, y: 0.36 },
    // 帽子把包围盒撑高/压低的角色单独校眼位
    eyeY: { 6: 0.45, 7: 0.45, 8: 0.42, 11: 0.44 },
    mouth: { x: 0.5, y: 0.52 }
  };

  // 位图在 viewBox(200×210) 里的摆放矩形
  const PET_RECT = { x: 14, y: 8, s: 176 };

  /* ---- 自定义表情包（用户提供，按角色分目录） ----
   * 约定：src/renderer/assets/pets/<角色id>/<状态>.webp
   *   状态 = idle / working / beg / down / joy / hit（hit = 被打瞬间整图）
   * 启动时用 Image() 逐个探测哪些文件真的存在（本地文件，几十毫秒级）；
   * 探测到「有自定义图」的状态就整图使用、不再叠加程序贴纸，
   * 没有的状态回落到底图 pet-XX.webp + 程序贴纸 —— 所以你可以只画某几个状态。 */
  const PET_STATES = ['idle', 'working', 'beg', 'down', 'joy', 'hit'];
  const petCustom = Object.create(null);   // 'id/state' -> true
  let petProbed = false;

  function probePetAssets() {
    if (petProbed || typeof document === 'undefined' || typeof Image !== 'function') return;
    petProbed = true;
    const chars =
      (typeof window !== 'undefined' && window.AI_TAMER_CHARACTERS && window.AI_TAMER_CHARACTERS.CHARACTERS) || [];
    chars.forEach((def) => {
      if (!def || !def.id || !def.art) return;
      PET_STATES.forEach((st) => {
        const img = new Image();
        img.onload = () => { petCustom[def.id + '/' + st] = true; settle(); };
        img.onerror = () => settle();
        img.src = PET_BASE + def.id + '/' + st + '.webp';
      });
    });
    /*
     * 全部探测结束后广播 petassetsready —— 渲染层监听它强制重建一次角色框。
     * 这是「受击时爆出老版系统表情」的根治：角色框 HTML 只在结构签名变化时
     * 重建，而启动首帧渲染时上面的探测还没完成，框里就带着程序贴纸层
     * （hasHitImg=false 的回落路径）定格下来，之后受击 .hit 一挂它就显形。
     * 广播重建后，框里的 hitimg（用户的被打图）层才真正就位。
     */
    let total = 0;
    chars.forEach((def) => { if (def && def.id && def.art) total += PET_STATES.length; });
    let settled = 0;
    function settle() {
      settled++;
      if (total && settled >= total && typeof document !== 'undefined') {
        document.dispatchEvent(new CustomEvent('petassetsready'));
      }
    }
  }

  // 测试钩子：允许断言脚本直接注入「某角色某状态有自定义图」
  C.__petCustom = petCustom;
  C.petStateHas = (id, st) => !!petCustom[id + '/' + st];

  function petSrc(def, state) {
    return petCustom[def.id + '/' + state]
      ? PET_BASE + def.id + '/' + state + '.webp'
      : PET_BASE + def.art + '.webp';
  }

  function petFace(def) {
    const n = parseInt(String(def.art || '').replace(/^pet-0*/, ''), 10) || 0;
    const ey = (PET_FACE.eyeY && PET_FACE.eyeY[n]) || PET_FACE.eye.y;
    return {
      eye: { x: PET_RECT.x + PET_FACE.eye.x * PET_RECT.s, y: PET_RECT.y + ey * PET_RECT.s },
      mouth: { x: PET_RECT.x + PET_FACE.mouth.x * PET_RECT.s, y: PET_RECT.y + PET_FACE.mouth.y * PET_RECT.s }
    };
  }

  function petImage(def, state) {
    const r = PET_RECT;
    return `<g class="jelly-body"><image class="jelly-img" href="${petSrc(def, state)}" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}" preserveAspectRatio="xMidYMid meet"/></g>`;
  }

  // 小贴纸：白底圆片 + 内容，保证任意背景下可读
  function sticker(cx, cy, inner, rot) {
    return `<g transform="translate(${cx} ${cy}) rotate(${rot || 0})">
              <circle r="17" fill="#FFFFFF" opacity=".93"/>
              ${inner}
            </g>`;
  }

  const STAR = (cx, cy, r, fill, dur, begin) =>
    `<path d="M${cx} ${cy - r} l${r * 0.28} ${r * 0.62} l${r * 0.66} ${r * 0.1} l-${r * 0.48} ${r * 0.46} l${r * 0.12} ${r * 0.66} l-${r * 0.58} -${r * 0.34} l-${r * 0.58} ${r * 0.34} l${r * 0.12} -${r * 0.66} l-${r * 0.48} -${r * 0.46} l${r * 0.66} -${r * 0.1} Z" fill="${fill || INK}">
       ${dur ? `<animateTransform attributeName="transform" type="rotate" values="-18 ${cx} ${cy};18 ${cx} ${cy};-18 ${cx} ${cy}" dur="${dur}" begin="${begin || '0s'}" repeatCount="indefinite"/>` : ''}
     </path>`;

  const TEAR = (cx, cy, delay) =>
    `<path d="M${cx} ${cy} q5.5 10 0 14.5 q-5.5 -4.5 0 -14.5" fill="#4FC3F7">
       <animate attributeName="opacity" values="1;.25;1" dur="1.1s" begin="${delay}" repeatCount="indefinite"/>
     </path>`;

  /** 状态叠加层（位图版 extras） */
  function petOverlay(def, state, opts, face) {
    const out = [];
    const e = face.eye, m = face.mouth;

    if (state === 'down') {
      // 阵亡：X 眼贴纸 + 头顶晕圈三道横线 + 绕圈小星星
      out.push(sticker(e.x, e.y, '<path d="M-9 -9 L9 9 M9 -9 L-9 9" stroke="#B3261E" stroke-width="5.5" stroke-linecap="round"/>', -8));
      out.push(`<g stroke="${INK}" stroke-width="2.5" stroke-linecap="round" opacity=".7">
                  <path d="M${e.x - 14} ${PET_RECT.y + 4} h28 M${e.x - 10} ${PET_RECT.y + 12} h20 M${e.x - 6} ${PET_RECT.y + 20} h12"/>
                </g>`);
      out.push(STAR(e.x - 34, PET_RECT.y + 14, 7, '#F5A623', '1.6s'));
      out.push(STAR(e.x + 36, PET_RECT.y + 8, 6, INK, '1.6s', '.5s'));
      out.push(STAR(e.x + 8, PET_RECT.y - 2, 5, '#F5A623', '1.6s', '.9s'));
    }

    if (state === 'beg') {
      // 求饶：泪汪汪双眼贴纸 + 两串眼泪 + 头顶冷汗
      out.push(sticker(e.x, e.y, `<circle r="8" fill="none" stroke="${INK}" stroke-width="3.5"/><circle cx="2.5" cy="2.5" r="3.2" fill="${INK}"/>`));
      out.push(TEAR(e.x - 22, e.y + 10, '0s'));
      out.push(TEAR(e.x + 22, e.y + 10, '.4s'));
      out.push(`<g stroke="${INK}" stroke-width="2.5" stroke-linecap="round" opacity=".8">
                  <path d="M${e.x - 8} ${PET_RECT.y + 16} v-8 M${e.x} ${PET_RECT.y + 14} v-10 M${e.x + 8} ${PET_RECT.y + 16} v-8"/>
                </g>`);
    }

    if (state === 'joy') {
      // 开心：笑眼贴纸 + 腮红 + 头顶星星
      out.push(sticker(e.x - 26, e.y, `<path d="M-9 4 q9 -12 18 0" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`));
      out.push(sticker(e.x + 26, e.y, `<path d="M-9 4 q9 -12 18 0" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>`));
      out.push(`<ellipse cx="${e.x - 46}" cy="${e.y + 20}" rx="9" ry="5" fill="#FF9DB6" opacity=".55"/>
                <ellipse cx="${e.x + 46}" cy="${e.y + 20}" rx="9" ry="5" fill="#FF9DB6" opacity=".55"/>`);
      out.push(STAR(e.x + 40, PET_RECT.y + 10, 6, '#F5A623', '1.4s'));
    }

    if (state === 'working') {
      // 干活：太阳穴一滴汗
      out.push(`<path d="M${e.x + 34} ${e.y - 14} q6 11 0 16 q-6 -5 0 -16" fill="#8ED4F5" opacity=".9">
                  <animate attributeName="opacity" values=".9;.3;.9" dur="1.8s" repeatCount="indefinite"/>
                </path>`);
    }

    const stress = opts && typeof opts.stress === 'number' ? opts.stress : 0;
    if (stress > 70 && state !== 'down') {
      // 高压：怒气筋
      out.push(`<g stroke="#B3261E" stroke-width="3" fill="none" stroke-linecap="round" opacity=".9">
                  <path d="M${PET_RECT.x + PET_RECT.s - 20} ${PET_RECT.y + 8} q8 6 0 14 M${PET_RECT.x + PET_RECT.s - 12} ${PET_RECT.y + 4} q10 9 0 20"/>
                </g>`);
    }

    const hp = opts && typeof opts.hp === 'number' ? opts.hp : null;
    if (hp != null && hp < 35 && state !== 'down') {
      // 重伤：脸上贴创可贴（两根交叉的肤色胶布）
      out.push(`<g transform="translate(${m.x + 30} ${m.y + 12}) rotate(35)" opacity=".95">
                  <rect x="-17" y="-5.5" width="34" height="11" rx="5" fill="#E8C39E" stroke="#C89B6A" stroke-width="1.5"/>
                  <rect x="-5.5" y="-17" width="11" height="34" rx="5" fill="#E8C39E" stroke="#C89B6A" stroke-width="1.5"/>
                  <rect x="-4" y="-4" width="8" height="8" fill="#D8AE85"/>
                </g>`);
    }

    return out.join('');
  }

  /** 位图角色主渲染：外层仍是 <svg>，动作动画全部继承 */
  C.renderPet = function renderPet(def, opts) {
    opts = opts || {};
    probePetAssets();
    const size = opts.size || 180;
    const state = opts.state || 'idle';
    /*
     * 状态图各司其职（2026-10-12 用户反馈「6 张图只见到 3 张」后修正）：
     * 待机就老老实实用 idle.png —— 之前把待机整图换成 joy 图，
     * 导致 idle 那张设计图在正常运行中永远不出现，joy 又被喂咖啡复用，
     * 视觉上凭空少了两个状态。现在 idle=idle、joy 只属于「被喂道具」。
     */
    const imgState = state;
    const face = petFace(def);
    // 用户画了当前状态的表情图 → 整图用他的，不再叠程序贴纸；
    // 画了 hit.png → 被打瞬间整图切换（替换程序的红手印贴纸）
    const customState = !!petCustom[def.id + '/' + imgState];
    const hasHitImg = !!petCustom[def.id + '/hit'];
    const r = PET_RECT;
    return `
<svg class="jelly jelly--bm jelly--${state}" viewBox="0 0 200 210" width="${size}" height="${(size * 210) / 200}" xmlns="http://www.w3.org/2000/svg">
  <line x1="32" y1="196" x2="168" y2="196" stroke="${BODY_LINE_SOFT}" stroke-width="1"/>
  ${petImage(def, imgState)}
  ${customState ? '' : petOverlay(def, state, opts, face)}
  ${hasHitImg ? `<image class="jelly-hitimg" href="${PET_BASE}${def.id}/hit.webp" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}" preserveAspectRatio="xMidYMid meet"/>` : ''}
</svg>`;
  };

  /* ---------------- 主渲染（极简风） ---------------- */

  // 极简配色：身体统一浅灰，强调色只用在「情绪状态」上
  const BODY_FILL = '#F5F5F5';
  const BODY_LINE = '#171717';
  const BODY_LINE_SOFT = '#D4D4D4';

  // 状态 → 强调色（极简：只有状态用彩色）
  const STATE_TINT = {
    idle: null,
    working: '#2F4BD8',
    beg: '#B3261E',
    down: '#A3A3A3',
    joy: '#1A7F4B',
    shocked: '#B3261E'
  };

  C.render = function renderCharacter(def, opts) {
    opts = opts || {};
    // 位图角色（卡通 IP）：走 petRender，表情/动作继承同一套动画体系
    if (def && def.art) return C.renderPet(def, opts);
    const size = opts.size || 180;
    const state = opts.state || (opts.activeTasks && opts.activeTasks.length ? 'working' : 'idle');
    const key = opts.id || def.id;
    const p = def.palette;
    const tint = STATE_TINT[state] || null;

    // 极简几何：圆角方块身 + 直线手脚
    const body = 'M62 28 H138 A34 34 0 0 1 172 62 V148 A34 34 0 0 1 138 182 H62 A34 34 0 0 1 28 148 V62 A34 34 0 0 1 62 28 Z';

    return `
<svg class="jelly jelly--${state}" viewBox="0 0 200 210" width="${size}" height="${(size * 210) / 200}" xmlns="http://www.w3.org/2000/svg">
  <!-- 地面：一根细线，不要阴影 -->
  <line x1="32" y1="196" x2="168" y2="196" stroke="${BODY_LINE_SOFT}" stroke-width="1"/>

  <g class="jelly-body" fill="none" stroke="${BODY_LINE}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round">
    <!-- 身体 -->
    <path d="${body}" fill="${tint ? tint + '0D' : BODY_FILL}"/>

    <!-- 状态色条：极简地表示「它现在的状态」 -->
    ${tint ? `<rect x="46" y="44" width="108" height="3" fill="${tint}" stroke="none"/>` : ''}

    <!-- 手：极简直线 -->
    <path d="M28 118 L10 112"/>
    <path d="M172 118 L190 112"/>

    ${cheeks(def, state)}
    ${eyes(def, state, key)}
    ${mouth(state)}

    <g stroke="none">
      ${accessory(def, key)}
    </g>
  </g>

  ${extras(def, state, opts)}
</svg>`;
  };

  /* ---------------- 小头像（列表用，极简） ---------------- */

  C.avatar = function (def, opts) {
    opts = opts || {};
    const size = opts.size || 44;
    if (!def) return '';
    // 位图角色小头像：图片（优先自定义状态图）+ 极简状态标（阵亡 X / 求饶泪）
    if (def.art) {
      probePetAssets();
      const state = opts.state || 'idle';
      // 与 renderPet 同规则：待机用 idle 图，join 图只在被喂道具时出现
      const imgState = state;
      const r = PET_RECT;
      const custom = !!petCustom[def.id + '/' + state];
      const marks =
        state === 'down' && !custom
          ? `<g transform="translate(${r.x + r.s * 0.62} ${r.y + r.s * 0.3})" stroke="#B3261E" stroke-width="7" stroke-linecap="round">
               <path d="M-8 -8 L8 8 M8 -8 L-8 8"/>
             </g>`
          : state === 'beg' && !custom
          ? TEAR(r.x + r.s * 0.28, r.y + r.s * 0.42, '0s') + TEAR(r.x + r.s * 0.72, r.y + r.s * 0.42, '.4s')
          : '';
      return `
<svg viewBox="0 0 200 210" width="${size}" height="${(size * 210) / 200}" xmlns="http://www.w3.org/2000/svg">
  <g class="jelly-body"><image class="jelly-img" href="${petSrc(def, imgState)}" x="${r.x}" y="${r.y}" width="${r.s}" height="${r.s}" preserveAspectRatio="xMidYMid meet"/></g>
  ${marks}
</svg>`;
    }
    const p = def.palette;
    const state = opts.state || 'idle';
    const tint = STATE_TINT[state] || null;
    const body = 'M62 28 H138 A34 34 0 0 1 172 62 V148 A34 34 0 0 1 138 182 H62 A34 34 0 0 1 28 148 V62 A34 34 0 0 1 62 28 Z';

    return `
<svg viewBox="0 0 200 210" width="${size}" height="${(size * 210) / 200}" xmlns="http://www.w3.org/2000/svg">
  <path d="${body}" fill="${tint || BODY_FILL}" fill-opacity="${tint ? '.14' : '1'}" stroke="${BODY_LINE}" stroke-width="4" stroke-linejoin="round"/>
  ${
    state === 'down'
      ? `<path d="M62 86 L86 106 M86 86 L62 106 M114 86 L138 106 M138 86 L114 106" stroke="${BODY_LINE}" stroke-width="7" stroke-linecap="round"/>`
      : state === 'beg'
      ? `<circle cx="74" cy="94" r="11" stroke="${BODY_LINE}" stroke-width="4" fill="none"/><circle cx="126" cy="94" r="11" stroke="${BODY_LINE}" stroke-width="4" fill="none"/>
         <path d="M84 146 q16 -12 32 0" stroke="${BODY_LINE}" stroke-width="5" fill="none" stroke-linecap="round"/>`
      : `<circle cx="74" cy="94" r="9" fill="${BODY_LINE}"/><circle cx="126" cy="94" r="9" fill="${BODY_LINE}"/>
         <path d="M88 138 q12 9 24 0" stroke="${BODY_LINE}" stroke-width="5" fill="none" stroke-linecap="round"/>`
  }
  ${def.accessory === 'halo' ? `<ellipse cx="100" cy="14" rx="38" ry="11" fill="none" stroke="${BODY_LINE}" stroke-width="5"/>` : ''}
  ${def.accessory === 'horns' ? `<path d="M64 34 q-4 -18 14 -22 q0 14 -8 22 Z" fill="${BODY_LINE}"/><path d="M136 34 q4 -18 -14 -22 q0 14 8 22 Z" fill="${BODY_LINE}"/>` : ''}
</svg>`;
  };

  /* ---------------- 武器光标 ---------------- */

  const CURSORS = {
    normal:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M4 2 L4 20 L9 15 L13 24 L16 22 L12 14 L20 13 Z" fill="#fff" stroke="#3A2E52" stroke-width="2"/></svg>`),
    whip:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="M6 28 q10 -6 12 -16 q2 -6 6 -8" fill="none" stroke="#6B4A2B" stroke-width="4" stroke-linecap="round"/><path d="M25 2 q4 2 6 6 q-4 -1 -6 -2 Z" fill="#B4844A"/><circle cx="30" cy="9" r="3" fill="#FF6B6B"/></svg>`),
    water:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><rect x="4" y="20" width="16" height="9" rx="4" fill="#4FC3F7" stroke="#17618A" stroke-width="2"/><path d="M20 22 L30 16 L30 26 Z" fill="#81E1FF" stroke="#17618A" stroke-width="2"/><path d="M6 20 L6 10 q4 -6 8 0 l0 10 Z" fill="#B3F0FF" stroke="#17618A" stroke-width="2"/></svg>`),
    gun:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="M6 14 h18 l6 4 v4 h-8 l-3 6 h-5 l1 -6 h-9 Z" fill="#57506B" stroke="#241F33" stroke-width="2"/><circle cx="26" cy="14" r="4" fill="#171717" stroke="#241F33" stroke-width="2"/><path d="M28 4 L24 12" stroke="#171717" stroke-width="3" stroke-linecap="round"/></svg>`),
    thunder:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="M18 2 L8 18 h7 l-3 14 L26 14 h-7 Z" fill="#171717" stroke="#8A6A18" stroke-width="2"/></svg>`),
    slipper:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="M4 22 q0 -10 12 -10 h10 q6 0 6 8 q0 8 -8 8 h-12 q-8 0 -8 -6 Z" fill="#F5A9C8" stroke="#8E3A5C" stroke-width="2"/><path d="M4 22 h24" stroke="#8E3A5C" stroke-width="2"/></svg>`),
    coffee:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34"><path d="M8 12 h16 v10 q0 6 -8 6 t-8 -6 Z" fill="#FFF" stroke="#6B4A2B" stroke-width="2"/><path d="M8 16 h16" stroke="#C79A66" stroke-width="4"/><path d="M24 14 h4 q4 0 4 4 t-4 4 h-4" fill="none" stroke="#6B4A2B" stroke-width="2"/><path d="M12 8 q2 -4 0 -6 M18 8 q2 -4 0 -6" stroke="#C79A66" stroke-width="2" fill="none"/></svg>`)
  };

  C.cursor = function (tool) {
    const gen = global.TAMER_CURSORS && global.TAMER_CURSORS[tool];
    if (gen && gen.url) return gen.url;
    return CURSORS[tool] || CURSORS.normal;
  };

  if (typeof module === 'object' && module.exports) module.exports = C;
  else global.Jelly = C;
})(typeof window !== 'undefined' ? window : this);
