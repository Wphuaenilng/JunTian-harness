#!/usr/bin/env node
/**
 * make-icon.mjs — writes assets/tray.png (32x32 RGBA) with no image library.
 *
 * A tray icon needs a real bitmap and this repo has no sharp/jimp, so the encoder is
 * written here: PNG = signature + IHDR + one zlib-deflated IDAT + IEND, each chunk
 * carrying its own CRC32. Deflate and CRC32 are both in node, so the whole asset is
 * reproducible with `node scripts/make-icon.mjs`.
 *
 * The glyph is the 天枢 mark reduced to what survives at 16 px on a taskbar: a ring with
 * a solid pivot dot and one tick toward the pole. Colours come from the product's own
 * tokens (blue `#4176E6` for the mark, ink `#0F1115` for the pivot) because a mid-blue is
 * legible on both the light and the dark Windows taskbar, while white and black are not.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../assets/tray.png')

const SIZE = 32
const MARK = [0x41, 0x76, 0xe6, 255]   // --ds-500
const PIVOT = [0x0f, 0x11, 0x15, 255]   // --nb-1000

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const t = Buffer.from(type, 'latin1')
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

const px = Buffer.alloc(SIZE * SIZE * 4)
const put = (x, y, rgba) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return
  const i = (y * SIZE + x) * 4
  for (let k = 0; k < 4; k++) px[i + k] = rgba[k]
}
const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy)

// ring: outer r=13, inner r=10 around the centre (15.5, 16.5)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = dist(x, y, 15.5, 16.5)
    if (d <= 13 && d >= 10) put(x, y, MARK)
  }
}
// pivot dot, r=4
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) if (dist(x, y, 15.5, 16.5) <= 4) put(x, y, PIVOT)
}
// tick from the ring up to the pole (the "pivot star" reading)
for (let y = 1; y <= 6; y++) for (let x = 15; x <= 16; x++) put(x, y, MARK)

// PNG scanlines: each row is preceded by a filter-type byte (0 = None).
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6  // bit depth 8, colour type 6 = RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, png)
const lit = Array.from({ length: SIZE * SIZE }, (_, i) => px[i * 4 + 3]).filter((a) => a !== 0).length
console.log(`wrote ${out} — ${png.length} bytes, ${SIZE}x${SIZE}, ${lit} opaque px`)
