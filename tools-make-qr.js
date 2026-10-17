/* 生成婚礼现场二维码：纯 Node，无第三方依赖
 * 用法：node tools-make-qr.js new-domain
 * 例：node tools-make-qr.js https://xxx.run.tcloudbase.com
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const ROOT = __dirname;

const ADMIN_KEY = 'w26-7fk3qm';
const MASTER_KEY = 'mx26-83hf9q';
const BASE = (process.argv[2] || 'https://wedding-330270-11-1253720254.sh.run.tcloudbase.com').replace(/\/+$/, '');
const OUT = path.join(ROOT, '..');

/* ---------- CRC32 ---------- */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/* 灰度 PNG：0=黑 255=白，每像素 1 字节 */
function writeGrayPng(file, matrix, modulePx, quiet) {
  const m = matrix.length, q = quiet || 4;
  const size = (m + q * 2) * modulePx;
  const raw = Buffer.alloc((size + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    const row = Math.floor(y / modulePx);
    for (let x = 0; x < size; x++) {
      const col = Math.floor(x / modulePx);
      const inside = row >= q && row < m + q && col >= q && col < m + q;
      const dark = inside && matrix[row - q][col - q] === 1;
      raw[p++] = dark ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
  return size;
}

const qrcode = require(path.join(ROOT, 'public', 'qrcode.js'));
function matrixOf(text) {
  const qr = qrcode(0, 'H'); // 自动选版本 + 最高纠错（打印脏了也能扫）
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const mx = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c) ? 1 : 0);
    mx.push(row);
  }
  return mx;
}

function make(name, text, targetPx) {
  const mx = matrixOf(text);
  const modulePx = Math.max(4, Math.round(targetPx / mx.length));
  const size = writeGrayPng(path.join(OUT, name), mx, modulePx, 4);
  console.log(name + ' → ' + size + 'px，' + mx.length + ' 模块，字符数 ' + text.length);
  return size;
}

console.log('基地址：' + BASE);
make('qr-宾客入口.png', BASE + '/', 1280);
make('qr-主持人控制台.png', BASE + '/admin?k=' + ADMIN_KEY, 1180);
make('qr-总控台.png', BASE + '/master?k=' + MASTER_KEY, 1180);
