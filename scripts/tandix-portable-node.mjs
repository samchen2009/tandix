/** Keep each bundled Windows Node executable at an immutable installed path. */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function portableNodePath(bundledNode, installedRuntime) {
  const digest = sha256(bundledNode)
  return { digest, path: join(installedRuntime, `node-${digest.slice(0, 16)}.exe`) }
}

export function installedPortableNodePath(bundledNode, installedRuntime) {
  const { digest, path } = portableNodePath(bundledNode, installedRuntime)
  for (const candidate of [join(installedRuntime, 'node.exe'), path]) {
    try {
      if (existsSync(candidate) && sha256(candidate) === digest) return candidate
    } catch { /* A locked or unreadable old executable must not block a new install. */ }
  }
  return null
}

export function installPortableNode(bundledNode, installedRuntime) {
  const existing = installedPortableNodePath(bundledNode, installedRuntime)
  if (existing) return existing
  const { digest, path } = portableNodePath(bundledNode, installedRuntime)
  mkdirSync(installedRuntime, { recursive: true })
  if (existsSync(path)) throw new Error(`Installed Node runtime is damaged: ${path}`)
  copyFileSync(bundledNode, path)
  if (sha256(path) !== digest) throw new Error(`Could not verify installed Node runtime: ${path}`)
  return path
}
