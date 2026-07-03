import { describe, it, expect } from 'vitest'
import { createZip } from './zip'

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function u32(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(off, true)
}

function u16(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint16(off, true)
}

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const LOCAL_HEADER_SIZE = 30
const CENTRAL_HEADER_SIZE = 46
const EOCD_SIZE = 22

describe('createZip', () => {
  it('writes a valid single-entry archive', async () => {
    const data = new TextEncoder().encode('hello')
    const b = await bytes(createZip([{ name: 'a.txt', data }]))

    expect(u32(b, 0)).toBe(LOCAL_SIG)
    // well-known CRC-32 of "hello"
    expect(u32(b, 14)).toBe(0x3610a686)
    expect(u32(b, 18)).toBe(5) // compressed size (store = original)
    expect(u32(b, 22)).toBe(5) // uncompressed size
    expect(u16(b, 26)).toBe(5) // name length
    expect(new TextDecoder().decode(b.subarray(30, 35))).toBe('a.txt')
    expect(new TextDecoder().decode(b.subarray(35, 40))).toBe('hello')

    const eocd = b.length - EOCD_SIZE
    expect(u32(b, eocd)).toBe(EOCD_SIG)
    expect(u16(b, eocd + 8)).toBe(1) // entries on this disk
    expect(u16(b, eocd + 10)).toBe(1) // entries total
  })

  it('links central directory entries to correct local offsets', async () => {
    const enc = new TextEncoder()
    const b = await bytes(
      createZip([
        { name: 'one', data: enc.encode('11') },
        { name: 'two', data: enc.encode('2222') },
      ]),
    )

    const eocd = b.length - EOCD_SIZE
    expect(u16(b, eocd + 10)).toBe(2)
    const cdSize = u32(b, eocd + 12)
    const cdOffset = u32(b, eocd + 16)
    expect(cdOffset + cdSize).toBe(eocd)

    expect(u32(b, cdOffset)).toBe(CENTRAL_SIG)
    expect(u32(b, cdOffset + 42)).toBe(0) // first local header offset

    const secondCentral = cdOffset + CENTRAL_HEADER_SIZE + 'one'.length
    expect(u32(b, secondCentral)).toBe(CENTRAL_SIG)
    const firstLocalSize = LOCAL_HEADER_SIZE + 'one'.length + 2 // header + name + data
    expect(u32(b, secondCentral + 42)).toBe(firstLocalSize)
    // second local header actually lives at that offset
    expect(u32(b, firstLocalSize)).toBe(LOCAL_SIG)
  })

  it('handles empty entry data', async () => {
    const b = await bytes(createZip([{ name: 'empty', data: new Uint8Array(0) }]))
    expect(u32(b, 0)).toBe(LOCAL_SIG)
    expect(u32(b, 14)).toBe(0) // CRC-32 of empty input
    expect(u32(b, 18)).toBe(0)
  })
})
