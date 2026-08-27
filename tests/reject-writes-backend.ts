import type { KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

class RejectWritesUnit implements KvUnit {
  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly initialTables: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ) {}

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return Promise.resolve({
      tables: Object.fromEntries(this.descriptor.tables.map(table => [
        table,
        { ...this.initialTables[table] },
      ])),
      global: null,
    })
  }

  putRecord(): Promise<void> {
    return Promise.reject(new Error('injected metadata write failure'))
  }

  deleteRecord(): Promise<void> {
    return Promise.reject(new Error('injected metadata write failure'))
  }

  setGlobal(): Promise<void> {
    return Promise.reject(new Error('injected metadata write failure'))
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Storage backend that loads configured table rows and rejects every mutation. */
export class RejectWritesBackend implements StorageBackend {
  constructor(
    private readonly initialTables: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  ) {}

  readonly kv = {
    open: (descriptor: KvUnitDescriptor): Promise<KvUnit> => Promise.resolve(
      new RejectWritesUnit(descriptor, this.initialTables),
    ),
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

interface FailFirstCheckpointWriteState {
  failed: boolean
  readonly tables: Record<string, Record<string, unknown>>
}

class FailFirstCheckpointWriteUnit implements KvUnit {
  constructor(
    private readonly descriptor: KvUnitDescriptor,
    private readonly state: FailFirstCheckpointWriteState,
  ) {}

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return Promise.resolve({
      tables: Object.fromEntries(this.descriptor.tables.map(table => [
        table,
        { ...this.state.tables[table] },
      ])),
      global: null,
    })
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    if (table === 'checkpoints' && !this.state.failed) {
      this.state.failed = true
      return Promise.reject(new Error('injected first checkpoint write failure'))
    }
    const records = this.state.tables[table] ??= {}
    records[key] = value
    return Promise.resolve()
  }

  deleteRecord(table: string, key: string): Promise<void> {
    delete this.state.tables[table]?.[key]
    return Promise.resolve()
  }

  setGlobal(): Promise<void> {
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Storage backend that rejects the first checkpoint mutation and persists later writes. */
export class FailFirstCheckpointWriteBackend implements StorageBackend {
  private readonly state: FailFirstCheckpointWriteState = { failed: false, tables: {} }

  readonly kv = {
    open: (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      for (const table of descriptor.tables) this.state.tables[table] ??= {}
      return Promise.resolve(new FailFirstCheckpointWriteUnit(descriptor, this.state))
    },
  }

  /** Return one successfully persisted record for an assertion. */
  record(table: string, key: string): unknown {
    return this.state.tables[table]?.[key]
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
