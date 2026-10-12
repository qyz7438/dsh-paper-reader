import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { userInfo, tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import { realpathSync } from 'node:fs'
import { resolveReaderSessionLocation } from './private-session-path.js'

const fixtureParent = process.platform === 'win32'
  ? join(userInfo().homedir, 'AppData', 'Local', 'Temp') : tmpdir()
const fixture = await mkdtemp(join(fixtureParent, 'reader-session-location-'))
if (!isAbsolute(fixture) || !realpathSync(fixture).startsWith(realpathSync(fixtureParent) + sep)) throw new Error('Unsafe fixture target')
try {
  assert.deepEqual(resolveReaderSessionLocation(fixture), {
    privateRoot: join(realpathSync(fixture), 'DSHReader', 'private'), source: 'ENV_EXISTING',
  })
  const corruptExisting = join(fixture, '\uFFFD')
  await mkdir(corruptExisting)
  if (process.platform === 'win32') {
    const expected = join(realpathSync(join(userInfo().homedir, 'AppData', 'Local')), 'DSHReader', 'private')
    for (const unusable of [corruptExisting, join(fixture, 'missing'), 'relative/data', '\u0000', '']) {
      assert.deepEqual(resolveReaderSessionLocation(unusable), { privateRoot: expected, source: 'OS_PROFILE' })
    }
    const cleanAlias = join(fixture, 'clean-alias')
    await symlink(corruptExisting, cleanAlias, 'junction')
    assert.deepEqual(resolveReaderSessionLocation(cleanAlias), { privateRoot: expected, source: 'OS_PROFILE' })
    assert.deepEqual(resolveReaderSessionLocation(process.env.LOCALAPPDATA), resolveReaderSessionLocation())
    console.log('PASS host and bridge share the OS profile fallback for unusable paths, including a clean junction to a corrupt Unicode target')
  } else {
    assert.deepEqual(resolveReaderSessionLocation(corruptExisting), { privateRoot: undefined, source: 'MISSING' })
  }
  console.log('PASS explicit existing local-data directory remains supported without writes or environment changes')
} finally {
  await rm(fixture, { recursive: true, force: true })
}
