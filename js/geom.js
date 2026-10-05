/**
 * CoverFit 的几何与编码纯函数。
 * 单独成一个文件，是为了能脱离浏览器直接跑测试 ——
 * 裁剪坐标换算错一格，用户看到的就是"裁出来跟预览不一样"，
 * 这种 bug 在浏览器里靠肉眼很难确认。
 */
(function (root) {
  'use strict';

  /* ================= 预设比例 ================= */

  // 只放真正会用得到的。公众号 2.35:1、小红书 3:4 这类是硬需求，
  // 光给 16:9 / 1:1 用户还得自己算。
  const PRESETS = [
    { id: 'free',  label: '自由',   hint: '',            w: 0, h: 0 },
    { id: '1-1',   label: '1:1',    hint: '头像 · 方形',   w: 1, h: 1 },
    { id: '4-3',   label: '4:3',    hint: '传统照片',     w: 4, h: 3 },
    { id: '3-2',   label: '3:2',    hint: '单反',         w: 3, h: 2 },
    { id: '16-9',  label: '16:9',   hint: '宽屏 · 视频',   w: 16, h: 9 },
    { id: '9-16',  label: '9:16',   hint: '竖屏 · 短视频', w: 9, h: 16 },
    { id: '3-4',   label: '3:4',    hint: '小红书',       w: 3, h: 4 },
    { id: '2-35-1',label: '2.35:1', hint: '公众号封面',    w: 2.35, h: 1 },
    { id: '1-91-1',label: '1.91:1', hint: '分享卡片 OG',   w: 1.91, h: 1 },
    { id: '2-1',   label: '2:1',    hint: '横幅',         w: 2, h: 1 },
    { id: '4-5',   label: '4:5',    hint: 'Instagram',   w: 4, h: 5 },
  ];

  function findPreset(id) { return PRESETS.find(p => p.id === id) || null; }

  /* ================= 图片在容器里的显示区域 ================= */

  /**
   * 计算图片 contain 缩放后在容器中的位置。
   * 裁剪框的坐标是相对容器的，所以必须知道图片实际画在哪。
   */
  function fitRect(nw, nh, cw, ch) {
    if (!(nw > 0) || !(nh > 0) || !(cw > 0) || !(ch > 0)) {
      return { x: 0, y: 0, w: 0, h: 0, scale: 1 };
    }
    const scale = Math.min(cw / nw, ch / nh);
    const w = nw * scale, h = nh * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale };
  }

  /* ================= 按比例求最大内接矩形 ================= */

  /**
   * 在给定区域里放一个指定比例的矩形，求最大能放多大。
   * 切换比例时用：原来选中的区域可能超出新比例的边界，需要重新贴合。
   */
  function maxRectForRatio(area, rw, rh) {
    if (!(rw > 0) || !(rh > 0)) return { w: area.w, h: area.h };
    if (area.w / area.h > rw / rh) {
      // 区域偏宽 → 受高度限制
      const h = area.h, w = h * rw / rh;
      return { w, h };
    }
    const w = area.w, h = w * rh / rw;
    return { w, h };
  }

  /** 切换比例：保持中心不变，尽量保留原来的"覆盖面积" */
  function applyRatio(crop, area, rw, rh) {
    const cur = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
    const cx = cur.x + cur.w / 2, cy = cur.y + cur.h / 2;

    let w = cur.w, h = cur.h;
    if (rw > 0 && rh > 0) {
      const ratio = rw / rh;
      // 以当前宽度为基准算高度，超出区域就改用最大内接
      h = w / ratio;
      if (h > area.h) {
        const m = maxRectForRatio(area, rw, rh);
        w = m.w; h = m.h;
      }
    }
    // 夹回区域
    const c2 = clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }, area);
    return c2;
  }

  /** 把矩形夹进区域（先保证尺寸不超，再保证位置不越界） */
  function clampRect(r, area) {
    let w = Math.min(r.w, area.w);
    let h = Math.min(r.h, area.h);
    let x = Math.min(Math.max(r.x, area.x), area.x + area.w - w);
    let y = Math.min(Math.max(r.y, area.y), area.y + area.h - h);
    return { x, y, w, h };
  }

  /* ================= 显示坐标 ↔ 原图坐标 ================= */

  /** 裁剪框（容器坐标）→ 原图像素坐标 */
  function toSource(crop, fit) {
    const s = fit.scale || 1;
    return {
      x: (crop.x - fit.x) / s,
      y: (crop.y - fit.y) / s,
      w: crop.w / s,
      h: crop.h / s,
    };
  }

  /** 原图像素坐标 → 裁剪框（容器坐标） */
  function fromSource(src, fit) {
    const s = fit.scale || 1;
    return {
      x: src.x * s + fit.x,
      y: src.y * s + fit.y,
      w: src.w * s,
      h: src.h * s,
    };
  }

  /** 像素取整并夹进原图范围，避免 drawImage 越界出现透明边 */
  function snapSource(src, nw, nh) {
    let x = Math.max(0, Math.round(src.x));
    let y = Math.max(0, Math.round(src.y));
    let w = Math.max(1, Math.round(src.w));
    let h = Math.max(1, Math.round(src.h));
    if (x + w > nw) w = nw - x;
    if (y + h > nh) h = nh - y;
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    return { x, y, w, h };
  }

  /* ================= 输出尺寸 ================= */

  /**
   * 输出尺寸：默认等于裁剪区原图尺寸，受最大边长限制。
   * maxSide=0 表示不限制。
   */
  function outputSize(src, maxSide) {
    let w = Math.max(1, Math.round(src.w));
    let h = Math.max(1, Math.round(src.h));
    if (maxSide > 0 && (w > maxSide || h > maxSide)) {
      const k = maxSide / Math.max(w, h);
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    return { w, h };
  }

  /** 按指定宽度等比算高度 */
  function sizeByWidth(src, w) {
    const ow = Math.max(1, src.w);
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(w * src.h / ow)) };
  }

  root.Geom = { PRESETS, findPreset, fitRect, maxRectForRatio, applyRatio,
                clampRect, toSource, fromSource, snapSource, outputSize, sizeByWidth };
})(typeof window !== 'undefined' ? window : globalThis);
