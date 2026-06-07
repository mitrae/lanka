import { LocalDiskStore, type MediaStore } from './media-store'
import { R2Store } from './r2-store'

let _store: MediaStore | null = null

export function useMediaStore(): MediaStore {
  if (!_store) {
    const config = useRuntimeConfig()
    const r2 = config.r2 as
      | {
          endpoint?: string
          bucket?: string
          accessKeyId?: string
          secretAccessKey?: string
        }
      | undefined
    if (r2?.endpoint && r2.bucket && r2.accessKeyId && r2.secretAccessKey) {
      _store = new R2Store({
        endpoint: r2.endpoint,
        bucket: r2.bucket,
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey
      })
    } else {
      _store = new LocalDiskStore(config.mediaDir)
    }
  }
  return _store
}

export function _setMediaStore(store: MediaStore | null): void {
  _store = store
}
