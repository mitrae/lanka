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
  /** True while polling should be active; stopPolling() flips this so an in-flight tick() can't re-arm the timer. */
  _polling: boolean
}

export const useMediaStore = defineStore('media', {
  state: (): State => ({
    list: [],
    uploads: [],
    failedUploads: [],
    loading: false,
    error: null,
    _api: useApiClient(),
    _pollTimer: null,
    _polling: false
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
      this._polling = true
      this.schedulePoll()
    },

    /** Seed from the server's active list (newest first — survives reloads) and start polling. */
    async pollUploads() {
      const active = await this._api.listActiveUploads()
      // Apply oldest→newest so each unshift-of-a-new-id ends with the newest job at the front,
      // matching the server's newest-first order; already-tracked ids are replaced in place.
      for (const j of [...active].reverse()) this.applyUpload(j)
      this._polling = true
      this.schedulePoll()
    },

    schedulePoll() {
      if (!this._polling || this._pollTimer || this.uploads.length === 0) return
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

    /** Replace an already-tracked job in place (preserves order); only a newly-seen job moves to the front. */
    applyUpload(job: UploadJob) {
      const idx = this.uploads.findIndex((u) => u.id === job.id)
      if (ACTIVE.has(job.status)) {
        if (idx >= 0) this.uploads.splice(idx, 1, job)
        else this.uploads.unshift(job)
        return
      }
      if (idx >= 0) this.uploads.splice(idx, 1)
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
      this._polling = false
      if (this._pollTimer) clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }
})
