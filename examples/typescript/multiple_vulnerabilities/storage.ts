import { readFileSync } from 'fs'
import { join } from 'path'

const UPLOADS = '/srv/app/uploads'

export function readAvatar(name: string): Buffer {
  return readFileSync(join(UPLOADS, name))
}

export function isInsideUploads(candidate: string): boolean {
  return join(UPLOADS, candidate).startsWith(UPLOADS + '/')
}
