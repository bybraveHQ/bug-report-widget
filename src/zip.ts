// Minimal ZIP writer (STORE method, no compression) — enough to bundle the
// report into a single download without pulling in a dependency.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const now = dosDateTime(new Date())
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const size = entry.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, now.time, true)
    lv.setUint16(12, now.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local, entry.data)

    const dir = new Uint8Array(46 + name.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(4, 20, true) // version made by
    dv.setUint16(6, 20, true) // version needed
    dv.setUint16(10, 0, true) // method: store
    dv.setUint16(12, now.time, true)
    dv.setUint16(14, now.date, true)
    dv.setUint32(16, crc, true)
    dv.setUint32(20, size, true)
    dv.setUint32(24, size, true)
    dv.setUint16(28, name.length, true)
    dv.setUint32(42, offset, true)
    dir.set(name, 46)
    central.push(dir)

    offset += local.length + size
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return new Blob([...parts, ...central, eocd] as BlobPart[], { type: 'application/zip' })
}
