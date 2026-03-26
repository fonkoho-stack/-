// 生成微信 TabBar 所需的 81x81 助手图标（机器人头像简笔画）
// 使用纯 JS 构建合法 PNG 文件（无需任何额外依赖）

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPNG(width, height, drawFn) {
  const channels = 4; // RGBA
  const raw = [];

  // 生成像素数据
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = drawFn(x, y, width, height);
      raw.push(r, g, b, a);
    }
  }

  const rawBuf = Buffer.from(raw);
  const compressed = zlib.deflateSync(rawBuf);

  // PNG chunks
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);

    const crcInput = Buffer.concat([typeBuf, data]);
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < crcInput.length; i++) {
      crc ^= crcInput[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);

    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', iend),
  ]);
}

// 距离函数
function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// 圆角矩形判定函数
function inRoundRect(px, py, left, top, right, bottom, radius) {
  if (px < left || px > right || py < top || py > bottom) return false;
  // 检查四个角
  const corners = [
    [left + radius, top + radius],
    [right - radius, top + radius],
    [left + radius, bottom - radius],
    [right - radius, bottom - radius],
  ];
  for (const [ccx, ccy] of corners) {
    if ((px < left + radius || px > right - radius) &&
        (py < top + radius || py > bottom - radius)) {
      if (dist(px, py, ccx, ccy) > radius) return false;
    }
  }
  return true;
}

// 绘制"机器人助手"图标 - 极简极简版（仅头部）
function drawAssistIcon(x, y, w, h, color) {
  const cx = w / 2;
  const cy = h / 2;
  const s = w / 81; // 归一化比例

  const cr = color[0], cg = color[1], cb = color[2];

  // 1. 头顶天线 (一根细线 + 小圆点)
  // 天线杆
  if (Math.abs(x - cx) <= 1.2 * s && y >= 14 * s && y <= 26 * s) {
    return [cr, cg, cb, 255];
  }
  // 天线球
  if (dist(x, y, cx, 14 * s) <= 4 * s) {
    return [cr, cg, cb, 255];
  }

  // 2. 头部 - 圆角矩形 (居中)
  const headW = 50 * s, headH = 38 * s;
  const hx1 = cx - headW / 2, hy1 = 26 * s;
  const hx2 = cx + headW / 2, hy2 = hy1 + headH;
  const headR = 12 * s;

  if (inRoundRect(x, y, hx1, hy1, hx2, hy2, headR)) {
    // 眼睛 - 两个简约的小圆
    const eyeY = hy1 + 16 * s;
    const eyeSpacing = 14 * s;
    const eyeRadius = 4.5 * s;
    if (dist(x, y, cx - eyeSpacing, eyeY) <= eyeRadius || dist(x, y, cx + eyeSpacing, eyeY) <= eyeRadius) {
      return [255, 255, 255, 255]; // 白色眼睛
    }
    // 脸部装饰线（可选，增加科技感）
    if (y >= hy1 + 28 * s && y <= hy1 + 29.5 * s && Math.abs(x - cx) <= 10 * s) {
      return [255, 255, 255, 100]; // 半透明装饰线
    }
    return [cr, cg, cb, 255];
  }

  return [0, 0, 0, 0];
}

const imgDir = path.join('d:/soft/python-progress/course_reminder/miniprogram/images');

// 灰色（未选中）
const grayColor = [142, 142, 147]; // #8E8E93
const grayPng = createPNG(81, 81, (x, y, w, h) => drawAssistIcon(x, y, w, h, grayColor));
fs.writeFileSync(path.join(imgDir, 'icon_assist.png'), grayPng);

// 绿色（选中）
const greenColor = [52, 199, 89]; // #34C759
const greenPng = createPNG(81, 81, (x, y, w, h) => drawAssistIcon(x, y, w, h, greenColor));
fs.writeFileSync(path.join(imgDir, 'icon_assist_active.png'), greenPng);

console.log('✅ 助手图标已生成:', imgDir);
