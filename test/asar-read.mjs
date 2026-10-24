/**
 * A minimal reader for Electron's `asar` archive format.
 *
 * The desktop build keeps every `@deepseek-ai/*` package inside
 * `resources/app.asar`, which the plain Node loader cannot open. This reads
 * the archive header and extracts individual files, so an integration test can
 * mount the real prompt registry instead of a stand-in.
 *
 * The format is a small header in front of a concatenated file blob:
 *   0  UInt32LE  size of the header-size pickle
 *   4  UInt32LE  size of the header block
 *   8  UInt32LE  size of the header-string pickle
 *  12  UInt32LE  pickle type (4 = string)
 *  16  the header JSON, describing every file's offset and size
 * and the file bytes start right after the header block.
 *
 * @module asar-read
 */

import { open, readFile, stat } from 'node:fs/promises'

/**
 * Read the archive's file table.
 *
 * @param {string} archivePath - the path of the `.asar` file.
 * @returns {Promise<{ base: number, files: object }>} the header.
 */
async function readHeader(archivePath) {
  const handle = await open(archivePath, 'r')
  try {
    const prefix = Buffer.alloc(16)
    await handle.read(prefix, 0, 16, 0)
    // The header is a nested pickle. The first four bytes are the size of the
    // next field; the second four are the size of the whole header block; the
    // header string's own length sits at offset 12; and the string itself
    // starts at offset 16.
    const headerSize = prefix.readUInt32LE(4)
    const stringSize = prefix.readUInt32LE(12)
    const headerBuffer = Buffer.alloc(stringSize)
    await handle.read(headerBuffer, 0, stringSize, 16)
    const json = headerBuffer.toString('utf8')
    // File bytes start right after the whole header block.
    return { base: 8 + headerSize, files: JSON.parse(json) }
  } finally {
    await handle.close()
  }
}

/**
 * Find a file's entry in the archive's table.
 *
 * @param {object} files - the header's file table.
 * @param {string} innerPath - the path inside the archive, using `/`.
 * @returns {object | null} the entry, or null when the path is absent.
 */
function findEntry(files, innerPath) {
  // The archive's top level is `{ files: { … } }`, and every directory entry is
  // `{ files: { … } }` too, so each step descends through `.files`.
  let node = files
  for (const segment of innerPath.split('/').filter(Boolean)) {
    if (node === undefined || node === null || typeof node !== 'object') return null
    const table = node.files !== undefined ? node.files : node
    node = table[segment]
    if (node === undefined) return null
  }
  if (node === undefined || node === null || typeof node !== 'object') return null
  return node
}

/**
 * Extract one file from an archive.
 *
 * @param {string} archivePath - the path of the `.asar` file.
 * @param {string} innerPath - the path inside the archive, using `/`.
 * @returns {Promise<Buffer | null>} the file bytes, or null when absent.
 */
export async function readFromAsar(archivePath, innerPath) {
  const { base, files } = await readHeader(archivePath)
  const entry = findEntry(files, innerPath)
  if (entry === undefined || entry === null || typeof entry !== 'object') return null
  // A link entry has no bytes of its own; its target lives elsewhere.
  if (entry.offset === undefined) return null
  const handle = await open(archivePath, 'r')
  try {
    const buffer = Buffer.alloc(entry.size)
    await handle.read(buffer, 0, entry.size, base + Number(entry.offset))
    return buffer
  } finally {
    await handle.close()
  }
}

/**
 * Extract one file from an archive into a directory on disk.
 *
 * Node's ESM loader reads a path, not a buffer, so a package that has to be
 * `import`ed is written out first.
 *
 * @param {string} archivePath - the path of the `.asar` file.
 * @param {string} innerPath - the path inside the archive, using `/`.
 * @param {string} outPath - where to write the file.
 * @returns {Promise<boolean>} whether the file was written.
 */
export async function extractFromAsar(archivePath, innerPath, outPath) {
  const bytes = await readFromAsar(archivePath, innerPath)
  if (bytes === null) return false
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, bytes)
  return true
}

/**
 * List every file inside an archive.
 *
 * @param {string} archivePath - the path of the `.asar` file.
 * @returns {Promise<string[]>} the inner paths.
 */
export async function listAsar(archivePath) {
  const { files } = await readHeader(archivePath)
  const out = []
  const walk = (node, prefix) => {
    const table = node?.files !== undefined ? node.files : node
    for (const [name, entry] of Object.entries(table ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (entry?.files !== undefined) walk(entry, path)
      else out.push(path)
    }
  }
  walk(files, '')
  return out
}

/**
 * Check that a path exists inside an archive.
 *
 * @param {string} archivePath - the path of the `.asar` file.
 * @param {string} innerPath - the path inside the archive.
 * @returns {Promise<boolean>} whether the entry exists.
 */
export async function asarHas(archivePath, innerPath) {
  const { files } = await readHeader(archivePath)
  return findEntry(files, innerPath) !== null
}

export { readFile, stat }
