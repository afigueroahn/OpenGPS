// Checksums the protocols close their frames with.

/** CRC-16/IBM (polynomial 0xA001), the one Teltonika uses. */
export function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}
