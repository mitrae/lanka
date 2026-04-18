import { eq } from 'drizzle-orm'
import { useDb } from '~/server/db/client'
import { useMediaStore } from '~/server/services/media-store-singleton'
import * as schema from '~/server/db/schema'

export type MediaPlan =
  | {
      status: 200 | 206
      start: number
      end: number // inclusive
      contentLength: number
      contentRange: string | null
    }
  | { status: 416 }

export function planMediaResponse(args: {
  fileBytes: number
  rangeHeader: string | undefined
}): MediaPlan {
  const { fileBytes, rangeHeader } = args
  if (!rangeHeader) {
    return {
      status: 200,
      start: 0,
      end: fileBytes - 1,
      contentLength: fileBytes,
      contentRange: null
    }
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
  if (!match) return { status: 416 }

  const [, startStr, endStr] = match
  let start: number
  let end: number

  if (startStr === '' && endStr !== '') {
    // suffix: last N bytes
    const n = Number(endStr)
    if (n <= 0) return { status: 416 }
    start = Math.max(0, fileBytes - n)
    end = fileBytes - 1
  } else if (startStr !== '' && endStr === '') {
    start = Number(startStr)
    end = fileBytes - 1
  } else if (startStr !== '' && endStr !== '') {
    start = Number(startStr)
    end = Math.min(Number(endStr), fileBytes - 1)
  } else {
    return { status: 416 }
  }

  if (start >= fileBytes || start > end) return { status: 416 }

  return {
    status: 206,
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${fileBytes}`
  }
}

export default defineEventHandler(async (event) => {
  const sha = getRouterParam(event, 'sha256')
  if (!sha) throw createError({ statusCode: 400 })

  const db = useDb()
  const [row] = await db
    .select()
    .from(schema.media)
    .where(eq(schema.media.sha256, sha))
  if (!row) throw createError({ statusCode: 404 })

  const store = useMediaStore()
  if (!(await store.has(sha))) throw createError({ statusCode: 404 })

  const plan = planMediaResponse({
    fileBytes: row.bytes,
    rangeHeader: getRequestHeader(event, 'range')
  })

  setResponseHeader(event, 'Accept-Ranges', 'bytes')
  setResponseHeader(
    event,
    'Content-Type',
    row.kind === 'video' ? 'video/mp4' : 'application/octet-stream'
  )
  setResponseHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')

  if (plan.status === 416) {
    setResponseHeader(event, 'Content-Range', `bytes */${row.bytes}`)
    setResponseStatus(event, 416)
    return null
  }

  setResponseHeader(event, 'Content-Length', String(plan.contentLength))
  if (plan.contentRange) {
    setResponseHeader(event, 'Content-Range', plan.contentRange)
  }
  setResponseStatus(event, plan.status)

  const stream = store.open(sha, { start: plan.start, end: plan.end })
  return sendStream(event, stream)
})
