import { LocalDiskStore, type MediaStore } from './media-store'

let _store: MediaStore | null = null

export function useMediaStore(): MediaStore {
  if (!_store) {
    const config = useRuntimeConfig()
    _store = new LocalDiskStore(config.mediaDir)
  }
  return _store
}

export function _setMediaStore(store: MediaStore | null): void {
  _store = store
}
