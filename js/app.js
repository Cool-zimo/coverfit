/* CoverFit —— 全部逻辑在浏览器本地完成，图片不上传。
 *
 * 三个容易做错、做错了用户会以为"工具坏了"的地方：
 *
 * 1. EXIF 方向。手机竖拍的照片，文件里是横着的，靠 EXIF 标记旋转。
 *    直接解码会把人拍成躺着的 —— 所以必须用 createImageBitmap 的
 *    imageOrientation: 'from-image'。
 *
 * 2. 透明转 JPEG 会变黑。PNG 有透明通道，JPEG 没有，浏览器默认填黑。
 *    必须先铺白底再画，否则用户看到一片黑以为导出失败。
 *
 * 3. 手机上手指比鼠标粗，14px 的手柄根本点不中 —— 窄屏放大到 20px。
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const GEOM = window.Geom, ENC = window.Enc;

  /* ================= 状态 ================= */

  const S = {
    items: [],            // { id, file, name, size, type, bitmap, w, h, srcCrop }
    cur: -1,
    bitmap: null, nw: 0, nh: 0,
    fit: null,            // { x:0, y:0, w, h, scale }
    crop: null,           // 舞台坐标
    ratioId: 'free',
    ratio: { w: 0, h: 0 },
    format: 'png',
    quality: 92,
    sizeMode: 'orig',     // orig | max | width
    maxSide: 0,
    outW: 0,
    supported: {},        // mime -> bool
    drag: null,
  };

  const MIN_CROP = 24;
  const ICO_MAX = 256;

  /* ================= 小工具 ================= */

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function fmtOf() { return ENC.findFormat(S.format); }

  /** 当前比例值：0 表示自由 */
  function ratioValue() {
    return (S.ratio.w > 0 && S.ratio.h > 0) ? S.ratio.w / S.ratio.h : 0;
  }

  /* ================= 文件载入 ================= */

  async function decode(file) {
    // 优先走 createImageBitmap：只有它能可靠地按 EXIF 摆正手机照片
    if (window.createImageBitmap) {
      try {
        const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
        if (b && b.width) return b;
      } catch (e) { /* 老浏览器不认 options，走下面的兜底 */ }
      try {
        const b = await createImageBitmap(file);
        if (b && b.width) return b;
      } catch (e) { /* 继续兜底 */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res;
        im.onerror = () => rej(new Error('decode failed'));
        im.src = url;
      });
      return im;
    } finally {
      // 位图已经解码进内存，URL 可以退了；Image 分支解码是同步完成的
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif|ico)$/i.test(f.name));
    if (!files.length) { toast('没有识别到图片文件'); return; }

    // 用户一上手就把示例图撤掉：留着它会混进队列，
    // 点"下载全部"时连示例图一起导出去，很莫名其妙。
    const hadDemo = S.items.some(x => x.id === 'demo');
    if (hadDemo) S.items = S.items.filter(x => x.id !== 'demo');

    let firstNew = -1;
    for (const f of files) {
      let bm;
      try { bm = await decode(f); }
      catch (e) { toast(`「${f.name}」读不出来，可能不是图片`); continue; }
      const item = {
        id: 'i' + Date.now() + Math.random().toString(36).slice(2, 6),
        file: f, name: f.name, size: f.size, type: f.type,
        bitmap: bm, w: bm.width, h: bm.height, srcCrop: null,
      };
      S.items.push(item);
      if (firstNew < 0) firstNew = S.items.length - 1;
    }
    if (firstNew < 0) return;

    $('drop').hidden = true;
    $('work').hidden = false;
    $('topActions').hidden = false;
    $('privacy').textContent = '全程在本地完成，图片不上传';
    select(firstNew);
    renderQueue();
    toast(S.items.length > 1 ? `已载入 ${S.items.length} 张` : '已载入');
  }

  function select(idx) {
    if (idx < 0 || idx >= S.items.length) return;
    S.cur = idx;
    const it = S.items[idx];
    S.bitmap = it.bitmap;
    S.nw = it.w; S.nh = it.h;
    S.fit = null; S.crop = null;
    layout(it.srcCrop || null);
    renderQueue();
    updateMeta();
  }

  /* ================= 布局 ================= */

  function layout(keepSrc) {
    if (!S.bitmap) return;
    const wrap = $('stageWrap');
    const availW = Math.max(160, wrap.clientWidth - 32);
    const availH = Math.max(220, Math.min(window.innerHeight * 0.62, 620));
    const f = GEOM.fitRect(S.nw, S.nh, availW, availH);

    // 记住裁切区在原图上的位置，缩放后还原 —— 否则窗口一变裁切框就跑偏
    let src = keepSrc;
    if (!src && S.crop && S.fit) src = GEOM.toSource(S.crop, S.fit);

    S.fit = { x: 0, y: 0, w: f.w, h: f.h, scale: f.scale };

    const stage = $('stage');
    stage.style.width = f.w + 'px';
    stage.style.height = f.h + 'px';

    const cv = $('stageCanvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(f.w * dpr);
    cv.height = Math.round(f.h * dpr);
    cv.style.width = f.w + 'px';
    cv.style.height = f.h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, f.w, f.h);
    g.drawImage(S.bitmap, 0, 0, f.w, f.h);

    if (src) {
      S.crop = GEOM.clampRect(GEOM.fromSource(src, S.fit), S.fit);
    } else {
      S.crop = initialCrop();
    }
    paintCrop();
  }

  /** 初始裁切框：按当前比例取最大内接矩形并居中 */
  function initialCrop() {
    const r = ratioValue();
    let w, h;
    if (r > 0) {
      const m = GEOM.maxRectForRatio(S.fit, S.ratio.w, S.ratio.h);
      w = m.w; h = m.h;
    } else {
      w = S.fit.w; h = S.fit.h;
    }
    return { x: (S.fit.w - w) / 2, y: (S.fit.h - h) / 2, w, h };
  }

  function paintCrop() {
    const c = $('crop');
    if (!S.crop) return;
    c.style.left = S.crop.x + 'px';
    c.style.top = S.crop.y + 'px';
    c.style.width = S.crop.w + 'px';
    c.style.height = S.crop.h + 'px';
    updateMeta();
  }

  /* ================= 裁切交互 ================= */

  /** 按手柄 + 位移算新矩形，锁比例时另一边跟着走 */
  function resizeRect(start, h, dx, dy, ratio, area) {
    let { x, y, w, h: hh } = start;
    const right = x + w, bottom = y + hh;
    const isW = h.includes('w'), isE = h.includes('e');
    const isN = h.includes('n'), isS = h.includes('s');

    // 各方向最多能长到多少（不越出图片区域）—— 先算出来再夹，
    // 比事后 clampRect 强行截断更好：锁比例时截断会破坏比例。
    const maxW = isE ? (area.x + area.w - x)
               : isW ? (right - area.x) : w;
    const maxH = isS ? (area.y + area.h - y)
               : isN ? (bottom - area.y) : hh;

    let nw = w, nh = hh;
    if (isE) nw = w + dx;
    if (isW) nw = w - dx;
    if (isS) nh = hh + dy;
    if (isN) nh = hh - dy;

    if (ratio > 0) {
      // 纵向手柄由高度驱动，其余由宽度驱动
      if ((isN || isS) && !isW && !isE) {
        nw = nh * ratio;
      } else {
        nh = nw / ratio;
      }
      // 超了就按能容纳的最大值回退，保持比例
      if (nw > maxW) { nw = maxW; nh = nw / ratio; }
      if (nh > maxH) { nh = maxH; nw = nh * ratio; }
    } else {
      if (nw > maxW) nw = maxW;
      if (nh > maxH) nh = maxH;
    }

    if (nw < MIN_CROP) { nw = MIN_CROP; if (ratio > 0) nh = nw / ratio; }
    if (nh < MIN_CROP) { nh = MIN_CROP; if (ratio > 0) nw = nh * ratio; }
    if (ratio > 0) {
      if (nw > maxW) { nw = maxW; nh = nw / ratio; }
      if (nh > maxH) { nh = maxH; nw = nh * ratio; }
    }

    let nx = x, ny = y;
    if (isW) nx = right - nw;      // 拖左边：右边界不动
    if (isN) ny = bottom - nh;     // 拖上边：下边界不动

    return GEOM.clampRect({ x: nx, y: ny, w: nw, h: nh }, area);
  }

  function bindCrop() {
    const cropEl = $('crop');

    cropEl.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      const handle = e.target.dataset && e.target.dataset.h;
      S.drag = {
        mode: handle ? 'resize' : 'move',
        handle: handle || '',
        start: { ...S.crop },
        px: e.clientX, py: e.clientY,
      };
      cropEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    cropEl.addEventListener('pointermove', e => {
      const d = S.drag;
      if (!d) return;
      const dx = e.clientX - d.px, dy = e.clientY - d.py;
      if (d.mode === 'move') {
        S.crop = GEOM.clampRect(
          { x: d.start.x + dx, y: d.start.y + dy, w: d.start.w, h: d.start.h },
          S.fit);
      } else {
        S.crop = resizeRect(d.start, d.handle, dx, dy, ratioValue(), S.fit);
      }
      paintCrop();
    });

    const end = e => {
      if (!S.drag) return;
      S.drag = null;
      try { cropEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // 松手后记进当前文件，切换回来还在
      const it = S.items[S.cur];
      if (it) it.srcCrop = GEOM.toSource(S.crop, S.fit);
      updateMeta();
    };
    cropEl.addEventListener('pointerup', end);
    cropEl.addEventListener('pointercancel', end);
  }

  /* ================= 比例 / 格式 / 尺寸 UI ================= */

  function buildRatios() {
    const box = $('ratios');
    box.innerHTML = GEOM.PRESETS.map(p =>
      `<button class="chip${p.id === S.ratioId ? ' on' : ''}" data-r="${p.id}">${p.label}` +
      (p.hint ? `<small>${p.hint}</small>` : '') + `</button>`).join('') +
      `<button class="chip" data-r="custom">自定义</button>`;
    box.querySelectorAll('[data-r]').forEach(el => {
      el.onclick = () => setRatio(el.dataset.r);
    });
  }

  function setRatio(id) {
    S.ratioId = id;
    $('customRow').hidden = (id !== 'custom');
    if (id === 'custom') return;    // 等用户填完点"应用"
    const p = GEOM.findPreset(id);
    S.ratio = p ? { w: p.w, h: p.h } : { w: 0, h: 0 };
    afterRatioChange();
  }

  function afterRatioChange() {
    if (!S.crop) return;
    const src = GEOM.toSource(S.crop, S.fit);
    S.crop = GEOM.applyRatio(S.crop, S.fit, S.ratio.w, S.ratio.h);
    // applyRatio 可能把框缩得很小，若原本接近全图就直接用最大内接
    if (src.w >= S.nw * 0.98 && src.h >= S.nh * 0.98) {
      S.crop = initialCrop();
    }
    paintCrop();
    const it = S.items[S.cur];
    if (it) it.srcCrop = GEOM.toSource(S.crop, S.fit);
  }

  function buildFormats() {
    const box = $('formats');
    box.innerHTML = ENC.FORMATS.map(f =>
      `<button class="chip${f.id === S.format ? ' on' : ''}" data-f="${f.id}" ` +
      `title="${f.note}">${f.label}</button>`).join('');
    box.querySelectorAll('[data-f]').forEach(el => {
      el.onclick = () => {
        if (el.disabled) return;
        S.format = el.dataset.f;
        syncFormatUI();
      };
    });
  }

  /** 探测哪些格式浏览器能直接编；编不了的禁用并说明 */
  async function probeFormats() {
    for (const f of ENC.FORMATS) {
      // BMP / ICO 是我们自己实现的，永远可用
      if (f.id === 'bmp' || f.id === 'ico') { S.supported[f.mime] = true; continue; }
      S.supported[f.mime] = await ENC.probe(f.mime);
    }
    $('formats').querySelectorAll('[data-f]').forEach(el => {
      const f = ENC.findFormat(el.dataset.f);
      const ok = S.supported[f.mime];
      el.disabled = !ok;
      el.title = ok ? f.note : '这个浏览器不支持导出 ' + f.label;
    });
    // 若当前默认格式不可用，退回 PNG
    if (!S.supported[fmtOf().mime]) { S.format = 'png'; }
    syncFormatUI();
  }

  function syncFormatUI() {
    $('formats').querySelectorAll('[data-f]').forEach(el => {
      el.classList.toggle('on', el.dataset.f === S.format);
    });
    const f = fmtOf();
    // 有损格式才有质量可言；PNG / BMP 调质量没有意义
    $('qualityRow').hidden = !f.lossy;
    let hint = f.note;
    if (f.id === 'jpeg') hint += ' · 透明区域会填成白色';
    if (f.id === 'ico') hint += ' · 最大 256×256，超出会自动缩小';
    if (f.id === 'gif') hint += ' · 只会导出第一帧';
    $('formatHint').textContent = hint;
    updateMeta();
  }

  function buildSizes() {
    const opts = [
      { id: 'orig', label: '原尺寸' },
      { id: 'max4096', label: '≤4096' },
      { id: 'max2048', label: '≤2048' },
      { id: 'max1200', label: '≤1200' },
      { id: 'max800', label: '≤800' },
      { id: 'width', label: '指定宽度' },
    ];
    $('sizes').innerHTML = opts.map(o =>
      `<button class="chip${o.id === S.sizeMode ? ' on' : ''}" data-s="${o.id}">${o.label}</button>`).join('');
    $('sizes').querySelectorAll('[data-s]').forEach(el => {
      el.onclick = () => {
        S.sizeMode = el.dataset.s;
        S.maxSide = /^max(\d+)$/.test(S.sizeMode) ? +RegExp.$1 : 0;
        $('sizes').querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', x === el));
        $('widthRow').hidden = (S.sizeMode !== 'width');
        updateMeta();
      };
    });
  }

  /** 输出尺寸：先裁剪区原图尺寸，再套用户限制 */
  function outSizeOf(src) {
    if (S.sizeMode === 'width' && S.outW > 0) return GEOM.sizeByWidth(src, S.outW);
    let s = GEOM.outputSize(src, S.maxSide);
    if (S.format === 'ico' && Math.max(s.w, s.h) > ICO_MAX) {
      s = GEOM.outputSize(src, ICO_MAX);
    }
    return s;
  }

  /* ================= 编码输出 ================= */

  function srcRect() {
    return GEOM.snapSource(GEOM.toSource(S.crop, S.fit), S.nw, S.nh);
  }

  async function makeBlob(fmtId, quality) {
    const f = ENC.findFormat(fmtId || S.format);
    const q = (quality == null ? S.quality : quality) / 100;
    const src = srcRect();
    let out = outSizeOf(src);

    const cv = document.createElement('canvas');
    cv.width = out.w; cv.height = out.h;
    const g = cv.getContext('2d');

    // 透明转 JPEG 会变黑 —— 先铺白底
    if (f.id === 'jpeg' || f.mime === 'image/jpeg') {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, out.w, out.h);
    }
    g.imageSmoothingQuality = 'high';
    g.drawImage(S.bitmap, src.x, src.y, src.w, src.h, 0, 0, out.w, out.h);

    if (f.id === 'bmp') {
      return ENC.bmpFromImageData(g.getImageData(0, 0, out.w, out.h));
    }
    if (f.id === 'ico') {
      const png = await new Promise(res => cv.toBlob(res, 'image/png'));
      if (!png) throw new Error('PNG 编码失败');
      const bytes = new Uint8Array(await png.arrayBuffer());
      return ENC.icoFromPng(bytes, out.w, out.h);
    }

    const blob = await new Promise(res => cv.toBlob(res, f.mime, f.lossy ? q : undefined));
    if (!blob) throw new Error(f.label + ' 编码失败');
    return blob;
  }

  /* ================= 信息面板 ================= */

  let metaTimer = null;
  function updateMeta() {
    if (!S.bitmap || !S.crop) return;
    const src = srcRect();
    const out = outSizeOf(src);

    // 原图尺寸和裁切尺寸立刻显示，体积是异步估的，不阻塞
    const it = S.items[S.cur];
    const fileRow = (it && it.size > 0) ? `<dt>文件</dt><dd>${ENC.humanSize(it.size)}</dd>` : '';
    $('meta').innerHTML = `
      <dt>原图</dt><dd>${S.nw} × ${S.nh}</dd>
      ${fileRow}
      <dt>裁切区</dt><dd>${src.w} × ${src.h}</dd>
      <dt>输出</dt><dd>${out.w} × ${out.h}</dd>
      <dt>格式</dt><dd>${fmtOf().label}</dd>
      <dt>预估体积</dt><dd id="estSize">…</dd>`;

    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
      try {
        const b = await makeBlob();
        const el = $('estSize');
        if (el) el.innerHTML = '<b>' + ENC.humanSize(b.size) + '</b>';
      } catch (e) {
        const el = $('estSize');
        if (el) el.textContent = '—';
      }
    }, 320);
  }

  /* ================= 下载 ================= */

  async function downloadOne(item, idx) {
    if (idx !== S.cur) {
      // 每个文件保留自己的裁切框，导出时临时切过去
      const savedCrop = S.crop, savedFit = S.fit;
      select(idx);
      try { await doDownload(item); }
      finally { S.crop = savedCrop; S.fit = savedFit; }
    } else {
      await doDownload(item);
    }
  }

  async function doDownload(item) {
    const blob = await makeBlob();
    const src = srcRect();
    const out = outSizeOf(src);
    const p = GEOM.findPreset(S.ratioId);
    const label = p && p.id !== 'free' ? p.label
      : (S.ratioId === 'custom' && S.ratio.w ? `${S.ratio.w}:${S.ratio.h}` : '');
    const f = fmtOf();
    const name = ENC.outName(item.name, label, out.w, out.h, f.ext);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return name;
  }

  async function downloadAll() {
    $('btnDownloadAll').disabled = true;
    const names = [];
    for (let i = 0; i < S.items.length; i++) {
      try { names.push(await downloadOne(S.items[i], i)); }
      catch (e) { toast('有一张导出失败'); }
      await new Promise(r => setTimeout(r, 260));   // 太快会被浏览器当成弹窗拦截
    }
    $('btnDownloadAll').disabled = false;
    toast(`已导出 ${names.length} 张`);
  }

  /* ================= 队列 ================= */

  function renderQueue() {
    const box = $('queue');
    if (S.items.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    $('queueCount').textContent = S.items.length + ' 张';
    $('queueItems').innerHTML = S.items.map((it, i) => {
      // 缩略图用原图直接画，省一次解码
      const w = 60, h = 60;
      const k = Math.min(w / it.w, h / it.h);
      const cw = Math.round(it.w * k), ch = Math.round(it.h * k);
      return `<div class="qitem${i === S.cur ? ' on' : ''}" data-i="${i}" title="${it.name}">
        <canvas width="${cw}" height="${ch}" data-thumb="${i}"
          style="position:absolute;left:${(w - cw) / 2}px;top:${(h - ch) / 2}px"></canvas>
        <span>${it.name}</span></div>`;
    }).join('');
    // canvas 得等插入 DOM 后才能画
    $('queueItems').querySelectorAll('[data-thumb]').forEach(cv => {
      const it = S.items[+cv.dataset.thumb];
      const g = cv.getContext('2d');
      g.drawImage(it.bitmap, 0, 0, cv.width, cv.height);
    });
    $('queueItems').querySelectorAll('[data-i]').forEach(el => {
      el.onclick = () => select(+el.dataset.i);
    });
  }

  /* ================= 事件绑定 ================= */

  function bindGlobal() {
    const drop = $('drop');

    const stop = e => { e.preventDefault(); e.stopPropagation(); };
    const clearDrag = () => {
      drop.classList.remove('over');
      document.body.classList.remove('dragging');
    };
    ['dragenter', 'dragover'].forEach(t => {
      document.addEventListener(t, e => {
        stop(e);
        drop.classList.add('over');
        document.body.classList.add('dragging');
      });
    });
    ['dragleave', 'drop'].forEach(t => {
      document.addEventListener(t, e => {
        stop(e);
        if (t === 'dragleave' && e.relatedTarget) return;
        clearDrag();
      });
    });
    document.addEventListener('drop', e => {
      clearDrag();
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) addFiles(dt.files);
    });

    $('btnPick').onclick = () => $('fileInput').click();
    $('btnChange').onclick = () => $('fileInput').click();
    $('fileInput').onchange = e => {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    };

    // 粘贴：截图后直接 Ctrl+V 是最快的路径
    document.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const fs = [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          const f = it.getAsFile();
          if (f) fs.push(f);
        }
      }
      if (fs.length) { e.preventDefault(); addFiles(fs); }
    });

    $('btnReset').onclick = () => {
      S.crop = initialCrop();
      paintCrop();
      const it = S.items[S.cur];
      if (it) it.srcCrop = GEOM.toSource(S.crop, S.fit);
      toast('裁切框已重置');
    };

    $('btnApplyCustom').onclick = () => {
      const w = parseFloat($('rw').value), h = parseFloat($('rh').value);
      if (!(w > 0) || !(h > 0)) { toast('比例要填大于 0 的数'); return; }
      S.ratio = { w, h };
      afterRatioChange();
    };
    $('rw').onkeydown = $('rh').onkeydown = e => { if (e.key === 'Enter') $('btnApplyCustom').click(); };

    $('quality').oninput = e => {
      S.quality = +e.target.value;
      $('qualityVal').textContent = S.quality;
      updateMeta();
    };
    $('outWidth').oninput = e => {
      S.outW = Math.max(0, parseInt(e.target.value, 10) || 0);
      updateMeta();
    };

    $('btnDownload').onclick = async () => {
      if (S.cur < 0) return;
      $('btnDownload').disabled = true;
      try { const n = await doDownload(S.items[S.cur]); toast('已下载 ' + n); }
      catch (e) { toast('导出失败：' + e.message); }
      $('btnDownload').disabled = false;
    };
    $('btnDownloadAll').onclick = downloadAll;

    // 窗口变化时重算，并保住裁切区的相对位置
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => layout(null), 160);
    });
  }

  /* ================= 启动 ================= */

  async function init() {
    buildRatios();
    buildFormats();
    buildSizes();
    bindCrop();
    bindGlobal();
    syncFormatUI();
    probeFormats();

    // 演示图：让第一次进来的人立刻看到界面长什么样，
    // 而不是对着一个空框猜怎么用。
    try { await loadDemo(); } catch (e) { /* 演示图失败不影响使用 */ }
  }

  async function loadDemo() {
    const dpr = window.devicePixelRatio || 1;
    const W = 1200, H = 800;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#5b3df0');
    grd.addColorStop(0.5, '#a24be0');
    grd.addColorStop(1, '#f0658a');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = '600 92px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('拖入你的图片', W / 2, H / 2 - 40);
    g.font = '400 34px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
    g.fillStyle = 'rgba(255,255,255,.7)';
    g.fillText('1200 × 800', W / 2, H / 2 + 50);
    // 四角标记，方便一眼看出裁掉了什么
    g.fillStyle = 'rgba(255,255,255,.5)';
    [[30, 30], [W - 30, 30], [30, H - 30], [W - 30, H - 30]].forEach(([x, y]) => {
      g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill();
    });

    const bm = await createImageBitmap(cv);
    S.items.push({
      id: 'demo', file: null, name: '示例图片.png', size: 0, type: 'image/png',
      bitmap: bm, w: W, h: H, srcCrop: null,
    });
    $('drop').hidden = true;
    $('work').hidden = false;
    $('topActions').hidden = false;
    select(0);
    $('privacy').textContent = '这是一张示例图 · 拖入你的图片替换';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }

  window.__coverfit = S;   // 便于自动化测试检查内部状态
})();
