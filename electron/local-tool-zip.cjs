const { inflateRaw } = require('node:zlib');
const inflate = require('node:util').promisify(inflateRaw);
/** Read selected bounded members; never extract archive-controlled paths. */
async function zipMembers(bytes, accept, limit = 32 * 1024 * 1024) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw Error('invalid-archive');
  const count = bytes.readUInt16LE(end + 10),
    directorySize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16),
    total = 0;
  if (count > 15000 || cursor + directorySize > end) throw Error('archive-limit');
  const output = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw Error('invalid-archive');
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      size = bytes.readUInt32LE(cursor + 24),
      packed = bytes.readUInt32LE(cursor + 20),
      length = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      offset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString('utf8');
    cursor += 46 + length + extra + comment;
    if (cursor > end) throw Error('invalid-archive');
    if (!accept(name)) continue;
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      (total += size) > limit ||
      offset + 30 > bytes.length ||
      bytes.readUInt32LE(offset) !== 0x04034b50
    )
      throw Error('archive-limit');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    if (start + packed > bytes.length) throw Error('invalid-archive');
    const data =
      method === 0
        ? bytes.subarray(start, start + packed)
        : await inflate(bytes.subarray(start, start + packed), {
            maxOutputLength: Math.max(1, size),
          });
    if (data.length !== size) throw Error('invalid-archive');
    output.push({ name, data });
  }
  return output;
}
module.exports = { zipMembers };
