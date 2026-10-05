/**
 * 浏览器 canvas.toBlob 不支持的格式，自己编。
 *
 * 为什么不全交给 toBlob：BMP 只有部分浏览器支持（Firefox 就不行），
 * ICO 是所有浏览器都不支持。如果不自己实现，选这两种格式会静默失败 ——
 * 按钮点了没反应，或者下载下来是个 PNG 却叫 .ico，打开直接报错。
 */
(function (root) {
  'use strict';

  /* ================= 格式表 ================= */

  const FORMATS = [
    { id: 'png',  mime: 'image/png',            ext: 'png',  label: 'PNG',  lossy: false, note: '无损 · 支持透明' },
    { id: 'jpeg', mime: 'image/jpeg',           ext: 'jpg',  label: 'JPEG', lossy: true,  note: '体积小 · 不支持透明' },
    { id: 'webp', mime: 'image/webp',           ext: 'webp', lossy: true,  note: '现代格式 · 支持透明' },
    { id: 'gif',  mime: 'image/gif',            ext: 'gif',  lossy: true,  note: '静态 · 动图会丢帧' },
    { id: 'bmp',  mime: 'image/bmp',            ext: 'bmp',  lossy: false, note: '无压缩 · 自研编码' },
    { id: 'ico',  mime: 'image/x-icon',         ext: 'ico',  lossy: false, note: '图标 · 自研编码' },
    { id: 'avif', mime: 'image/avif',           ext: 'avif', lossy: true,  note: '新一代 · 压缩率高' },
  ];

  function findFormat(id) { return FORMATS.find(f => f.id === id) || null; }

  /**
   * 探测画布能不能直接编出某种格式。
   * 用 1×1 画布试一次，比查 UA 可靠得多 —— 编不出来时浏览器会静默退化成 PNG，
   * 只看 toBlob 有没有返回值是发现不了的，必须看 blob.type。
   */
  function probe(mime) {
    return new Promise(resolve => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        c.getContext('2d').fillRect(0, 0, 1, 1);
        if (!c.toBlob) { resolve(false); return; }
        c.toBlob(b => {
          resolve(!!b && b.type === mime);   // 退化成 PNG 说明不支持
        }, mime);
      } catch (e) { resolve(false); }
    });
  }

  /* ================= BMP 编码 ================= */

  /**
   * 32 位 BGRA 位图。
   * 两个必须注意的点：行序是自下而上（biHeight 为正表示 bottom-up），
   * 每行字节数要 4 字节对齐（32bpp 天然满足，但补零逻辑保留以防改色深）。
   */
  function bmpFromImageData(img) {
    const w = img.width, h = img.height;
    const bpp = 4;
    const rowSize = Math.floor((w * 32 + 31) / 32) * 4;   // 4 字节对齐
    const pixSize = rowSize * h;
    const total = 54 + pixSize;

    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // BITMAPFILEHEADER
    view.setUint8(0, 0x42);            // 'B'
    view.setUint8(1, 0x4D);            // 'M'
    view.setUint32(2, total, true);    // bfSize
    view.setUint32(6, 0, true);        // reserved
    view.setUint32(10, 54, true);      // bfOffBits

    // BITMAPINFOHEADER
    view.setUint32(14, 40, true);      // biSize
    view.setInt32(18, w, true);        // biWidth
    view.setInt32(22, h, true);        // biHeight（正 = bottom-up）
    view.setUint16(26, 1, true);       // biPlanes
    view.setUint16(28, 32, true);      // biBitCount
    view.setUint32(30, 0, true);       // BI_RGB
    view.setUint32(34, pixSize, true); // biSizeImage
    view.setUint32(38, 0, true);       // biXPelsPerMeter
    view.setUint32(42, 0, true);       // biYPelsPerMeter
    view.setUint32(46, 0, true);       // biClrUsed
    view.setUint32(50, 0, true);       // biClrImportant

    const src = img.data;
    let off = 54;
    for (let y = h - 1; y >= 0; y--) {           // 自下而上
      const rowStart = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = rowStart + x * 4;
        // RGBA → BGRA；alpha 原样带过去
        u8[off]     = src[i + 2];
        u8[off + 1] = src[i + 1];
        u8[off + 2] = src[i];
        u8[off + 3] = src[i + 3];
        off += 4;
      }
      off += rowSize - w * 4;                    // 行补齐
    }
    return new Blob([buf], { type: 'image/bmp' });
  }

  /* ================= ICO 编码 ================= */

  /**
   * ICO 内嵌 PNG（Vista 起支持，macOS / Windows / Linux 通吃）。
   * 尺寸超过 256 会被很多解析器拒绝，所以先缩再编。
   */
  function icoFromPng(pngBytes, w, h) {
    const n = Math.min(w, h);
    const size = n >= 256 ? 0 : n;               // 256 在字段里记作 0

    const buf = new ArrayBuffer(6 + 16 + pngBytes.length);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    // ICONDIR
    view.setUint16(0, 0, true);       // reserved
    view.setUint16(2, 1, true);       // type: 1 = icon
    view.setUint16(4, 1, true);       // 一张图

    // ICONDIRENTRY
    view.setUint8(6, size);           // width
    view.setUint8(7, size);           // height
    view.setUint8(8, 0);              // colorCount
    view.setUint8(9, 0);              // reserved
    view.setUint16(10, 1, true);      // planes
    view.setUint16(12, 32, true);     // bitCount
    view.setUint32(14, pngBytes.length, true);
    view.setUint32(18, 22, true);     // imageOffset = 6 + 16

    u8.set(pngBytes, 22);
    return new Blob([buf], { type: 'image/x-icon' });
  }

  /* ================= 文件名 ================= */

  /** 去掉原扩展名，转成合法文件名 */
  function baseName(name) {
    return String(name || 'image')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .trim() || 'image';
  }

  /** 生成输出文件名：原名-比例-尺寸.扩展名 */
  function outName(orig, ratioLabel, w, h, ext) {
    const b = baseName(orig);
    const tag = ratioLabel ? '-' + ratioLabel.replace(/[:.]/g, '') : '';
    const dim = `-${w}x${h}`;
    return `${b}${tag}${dim}.${ext}`;
  }

  /** 人类可读的体积 */
  function humanSize(bytes) {
    if (!(bytes > 0)) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const v = bytes / Math.pow(1024, i);
    return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }

  root.Enc = { FORMATS, findFormat, probe, bmpFromImageData, icoFromPng,
               baseName, outName, humanSize };
})(typeof window !== 'undefined' ? window : globalThis);
