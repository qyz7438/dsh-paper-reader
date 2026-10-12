import { realpathSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'

function validLocalPath(value) {
  return typeof value === 'string' && value.length > 0 && !/[\u0000\uFFFD]/u.test(value) && isAbsolute(value)
}

function existingLocalDirectory(value) {
  if (!validLocalPath(value)) return undefined
  try {
    if (!statSync(value).isDirectory()) return undefined
    const canonical = realpathSync(value)
    return validLocalPath(canonical) ? canonical : undefined
  } catch { return undefined }
}

/** Resolve one shared host/bridge session directory without changing process env. */
export function resolveReaderSessionLocation(localAppData = process.env.LOCALAPPDATA) {
  let local = existingLocalDirectory(localAppData)
  if (local) return { privateRoot: join(local, 'DSHReader', 'private'), source: 'ENV_EXISTING' }
  if (process.platform === 'win32') {
    // userInfo().homedir comes from Windows, independently of USERPROFILE and
    // LOCALAPPDATA. Use only an already-existing standard local-data directory.
    try { local = existingLocalDirectory(join(userInfo().homedir, 'AppData', 'Local')) } catch { /* fail closed below */ }
    if (local) return { privateRoot: join(local, 'DSHReader', 'private'), source: 'OS_PROFILE' }
  }
  return { privateRoot: undefined, source: 'MISSING' }
}
