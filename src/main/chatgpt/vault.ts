import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatGPTError } from './errors'
export interface Credentials {
  accessToken: string
  refreshToken?: string
  idToken: string
  scopes: string[]
  expiresAt: number
  earliestRefreshAt: number
  nonce: string
}
export interface Registration {
  id: string
  clientId: string
  subject?: string
  email?: string
  credentials?: Credentials
}
export interface AuthRecord {
  planNoticeSeen?: boolean
  profiles: Registration[]
  activeId: string | null
}
export interface AuthVault {
  hostId(): Promise<string>
  load(): Promise<AuthRecord>
  save(record: AuthRecord): Promise<void>
}
export interface Encryption {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?: () => string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}
export class FileAuthVault implements AuthVault {
  constructor(
    private directory: string,
    private encryption: Encryption,
  ) {}
  private secure() {
    if (
      !this.encryption.isEncryptionAvailable() ||
      this.encryption.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw new ChatGPTError('storage')
  }
  private async write(name: string, bytes: Buffer | string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = join(this.directory, name),
      temp = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
  async hostId(): Promise<string> {
    try {
      const host = JSON.parse(await readFile(join(this.directory, 'host.json'), 'utf8'))
      if (/^urn:uuid:[0-9a-f-]{36}$/.test(host.hostId)) return host.hostId
      throw new ChatGPTError('storage')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ChatGPTError('storage')
      const hostId = 'urn:uuid:' + randomUUID()
      await this.write('host.json', JSON.stringify({ hostId }))
      return hostId
    }
  }
  async load(): Promise<AuthRecord> {
    try {
      const bytes = await readFile(join(this.directory, 'connections.enc'))
      this.secure()
      const data = JSON.parse(this.encryption.decryptString(bytes)) as AuthRecord
      if (
        !data ||
        !Array.isArray(data.profiles) ||
        (data.planNoticeSeen !== undefined && typeof data.planNoticeSeen !== 'boolean') ||
        (data.activeId !== null && typeof data.activeId !== 'string') ||
        new Set(data.profiles.map((p) => p.id)).size !== data.profiles.length ||
        new Set(data.profiles.map((p) => p.clientId)).size !== data.profiles.length ||
        data.profiles.some((p) => {
          if (
            !p ||
            typeof p.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(p.clientId) ||
            p.clientId === 'dynamic_agent_client'
          )
            return true
          if (p.subject !== undefined && (typeof p.subject !== 'string' || !p.subject)) return true
          if (p.email !== undefined && typeof p.email !== 'string') return true
          const c = p.credentials
          return (
            !!c &&
            (!p.subject ||
              typeof c.accessToken !== 'string' ||
              !c.accessToken ||
              typeof c.idToken !== 'string' ||
              !c.idToken ||
              (c.refreshToken !== undefined && typeof c.refreshToken !== 'string') ||
              !Array.isArray(c.scopes) ||
              c.scopes.some((s) => typeof s !== 'string') ||
              !Number.isFinite(c.expiresAt) ||
              !Number.isFinite(c.earliestRefreshAt) ||
              typeof c.nonce !== 'string')
          )
        })
      )
        throw new ChatGPTError('storage')
      return data
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [], activeId: null }
      throw new ChatGPTError('storage')
    }
  }
  async save(record: AuthRecord): Promise<void> {
    try {
      this.secure()
      await this.write('connections.enc', this.encryption.encryptString(JSON.stringify(record)))
    } catch {
      throw new ChatGPTError('storage')
    }
  }
}
