/** Download only files linked by this session's assistant inside its task directories. */
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024
export const ARTIFACT_DELIVERY_INSTRUCTIONS = 'When delivering a generated file, verify it exists and include a Markdown download link to its actual absolute local path, using <angle brackets> around paths with spaces. Save deliverables under your task workspace (prefer output/) or the selected task folder. A bold "Download" label without a link is not a deliverable; never invent a sandbox path or claim a download succeeded without a file.'

function artifactPath(value, cwd) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('Invalid artifact path')
  let path = value
  if (/^file:/iu.test(path)) path = fileURLToPath(path)
  else {
    if (path.startsWith('sandbox:')) path = path.slice(8)
    path = decodeURIComponent(path)
  }
  if (/[\u0000-\u001f\u007f]/u.test(path) || path.startsWith('//') || path.startsWith('\\\\')
    || (!isAbsolute(path) && !/^(?:\.\/|output\/|artifacts\/)/u.test(path))) throw new Error('Invalid artifact path')
  return resolve(cwd, path)
}

function linkedPaths(events, cwd) {
  const paths = new Set()
  for (const entry of events ?? []) {
    const event = entry?.event
    if (event?.type !== 'assistant/message') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      // Inline Markdown links, including <paths with spaces>. Never treat a user message as a file grant.
      for (const match of block.text.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/gu)) {
        try { paths.add(artifactPath(match[1] ?? match[2], cwd)) } catch { /* Remote or invalid link. */ }
      }
    }
  }
  return paths
}

export async function readSessionArtifact({ path, events, cwd, roots = [cwd] }) {
  const requested = artifactPath(path, cwd)
  if (!linkedPaths(events, cwd).has(requested)) throw new Error('This file is not linked by an assistant reply in this session. Wait for the reply to finish, then retry.')
  const target = await realpath(requested)
  const allowed = await Promise.all(roots.filter(Boolean).map(root => realpath(root).catch(() => null)))
  if (!allowed.some(root => {
    if (root === null) return false
    const child = relative(root, target)
    return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child)
  })) throw new Error('The file is outside this session’s task directories. Ask the agent to save it in its workspace output directory.')
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Artifact is not a regular file')
    if (info.size > ARTIFACT_MAX_BYTES) throw new Error('Artifact exceeds the 25 MiB download limit')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (chunk.bytesRead === 0) break
      offset += chunk.bytesRead
    }
    const after = await handle.stat()
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('The file changed during download. Wait for generation to finish, then retry.')
    const mediaType = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip' })[extname(target).toLowerCase()] ?? 'application/octet-stream'
    return { filename: basename(target), mediaType, size: bytes.length, data: bytes.toString('base64') }
  } finally { await handle.close() }
}
