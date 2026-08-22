// app/stores/media.ts
import { defineStore } from 'pinia'
import { useApiClient, type ApiClient } from '~/app/composables/useApiClient'
import { uploadFile } from '~/app/composables/useUploader'
import type { MediaListRow, UploadJob } from '~/app/types/api'

export const POLL_INTERVAL_MS = 3000
const ACTIVE = new Set<UploadJob['status']>(['pending', 'queued', 'processing'])

interface State {
  list: MediaListRow[]
  /** In-flight upload jobs (pending/queued/processing), newest first. */
  uploads: UploadJob[]
  /** Terminal failures the page has not toasted yet. */
  failedUploads: UploadJob[]
  loading: boolean
  error: string | null
  _api: Pick<
    ApiClient,
    'listMedia' | 'deleteMedia' | 'createUpload' | 'completeUpload' | 'getUpload' | 'listActiveUploads' | 'cancelUpload'
  >
  _pollTimer: ReturnType<typeof setTimeout> | null
}

export const useMediaStore = defineStore('media', {
  state: (): State => ({
    list: [],
    uploads: [],
    failedUploads: [],
    loading: false,
    error: null,
    _api: useApiClient(),
    _pollTimer: null
  }),
  actions: {
    async refresh() {
      this.loading = true
      this.error = null
      try {
        this.list = await this._api.listMedia()
      } catch (err: any) {
        this.error = err.message ?? String(err)
      } finally {
        this.loading = false
      }
    },

    async delete(id: number, opts: { force?: boolean } = {}): Promise<void> {
      await this._api.deleteMedia(id, opts)
      this.list = this.list.filter((m) => m.id !== id)
    },

    /** create job → PUT bytes to the ticket → complete. Resolves with the queued job. */
    async startUpload(
      file: File,
      opts: {
        kind: 'video' | 'image'
        quality: 'low' | 'standard' | 'high'
        onProgress?: (fraction: number) => void
        signal?: AbortSignal
        uploadFn?: typeof uploadFile
      }
    ): Promise<UploadJob> {
      const created = await this._api.createUpload({
        filename: file.name,
        kind: opts.kind,
        quality: opts.quality,
        mimeType: file.type || 'application/octet-stream',
        bytes: file.size
      })
      try {
        await (opts.uploadFn ?? uploadFile)({
          ...created.upload,
          file,
          onProgress: opts.onProgress,
          signal: opts.signal
        })
      } catch (err) {
        // Best effort: free the pending row + any partial staged object.
        await this._api.cancelUpload(created.id).catch(() => {})
        throw err
      }
      const job = await this._api.completeUpload(created.id)
      this.trackUpload(job)
      return job
    },

    trackUpload(job: UploadJob) {
      this.applyUpload(job)
      this.schedulePoll()
    },

    /** Seed from the server's active list (survives reloads) and start polling. */
    async pollUploads() {
      const active = await this._api.listActiveUploads()
      for (const j of active) this.applyUpload(j)
      this.schedulePoll()
    },

    schedulePoll() {
      if (this._pollTimer || this.uploads.length === 0) return
      this._pollTimer = setTimeout(() => {
        this._pollTimer = null
        void this.tick()
      }, POLL_INTERVAL_MS)
    },

    /** One polling round over every tracked job (in parallel — one slow job must not stall the round). */
    async tick() {
      const tracked = [...this.uploads]
      const results = await Promise.allSettled(tracked.map((u) => this._api.getUpload(u.id)))
      let refresh = false
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          this.applyUpload(r.value)
          if (r.value.status === 'done') refresh = true
          return
        }
        const err: any = r.reason
        const status = err?.status ?? err?.statusCode ?? err?.response?.status
        if (status === 404) this.uploads = this.uploads.filter((u) => u.id !== tracked[i].id)
        // other errors: keep the job, retry next round
      })
      if (refresh) await this.refresh()
      this.schedulePoll()
    },

    applyUpload(job: UploadJob) {
      const rest = this.uploads.filter((u) => u.id !== job.id)
      if (ACTIVE.has(job.status)) {
        this.uploads = [job, ...rest]
        return
      }
      this.uploads = rest
      if (
        (job.status === 'failed' || job.status === 'expired') &&
        !this.failedUploads.some((f) => f.id === job.id)
      ) {
        this.failedUploads.push(job)
      }
    },

    takeFailedUploads(): UploadJob[] {
      const out = this.failedUploads
      this.failedUploads = []
      return out
    },

    stopPolling() {
      if (this._pollTimer) clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }
})
