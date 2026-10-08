/**
 * Package identity, read from the manifest itself so the CLI, the kernel and
 * any host adapter report the same version without duplication.
 *
 * @module dsh-jev-judge/meta
 */

import { readFileSync } from 'node:fs'

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

/** The npm package name. */
export const PACKAGE_NAME = manifest.name

/** The released version of this package. */
export const VERSION = manifest.version
