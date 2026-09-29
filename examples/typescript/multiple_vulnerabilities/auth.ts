import { createHash } from 'crypto'
import jwt from 'jsonwebtoken'

const JWT_SECRET = 's3cr3t-signing-key'

export function hashPassword(password: string): string {
  return createHash('md5').update(password).digest('hex')
}

export function issueToken(user: string): string {
  return jwt.sign({ sub: user }, JWT_SECRET)
}

export function currentUser(authorization: string): unknown {
  const token = authorization.replace(/^Bearer /, '')
  return jwt.decode(token)
}
