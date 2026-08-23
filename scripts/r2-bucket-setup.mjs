// scripts/r2-bucket-setup.mjs
//
// One-off bucket configuration for direct-to-R2 uploads (see
// docs/superpowers/specs/2026-08-22-direct-r2-upload-async-ingest-design.md):
//   1. CORS: allow the dashboard origin to PUT presigned uploads (merged into
//      any existing rules — other rules are preserved).
//   2. Lifecycle: expire staged objects under uploads/ after 1 day, in case
//      the app's own sweeper never gets to them (downtime, rollback, lost row).
// Idempotent — re-running replaces only the Lanka-managed rules.
//
// Local:   set -a; . ./.env; set +a; node scripts/r2-bucket-setup.mjs --origin https://app.lanka.live
// Prod:    docker cp scripts/r2-bucket-setup.mjs lanka:/app/r2-bucket-setup.mjs \
//          && docker exec lanka node /app/r2-bucket-setup.mjs --origin https://app.lanka.live
//          (must land under /app — ESM bare-specifier resolution for
//          @aws-sdk/client-s3 walks up from the SCRIPT's directory looking
//          for node_modules; /tmp has none, so a copy there fails with
//          ERR_MODULE_NOT_FOUND even with -w /app)
import {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand
} from '@aws-sdk/client-s3'

function env(...names) {
  for (const n of names) if (process.env[n]) return process.env[n]
  console.error(`Missing env: ${names.join(' or ')}`)
  process.exit(1)
}

const originArg = process.argv.indexOf('--origin')
const origin = (originArg > -1 ? process.argv[originArg + 1] : env('APP_BASE_URL', 'NUXT_MAIL_BASE_URL')).replace(/\/$/, '')
if (!/^https?:\/\//.test(origin)) {
  console.error(`--origin must be an absolute URL, got: ${origin}`)
  process.exit(1)
}

const Bucket = env('R2_BUCKET', 'NUXT_R2_BUCKET')
const s3 = new S3Client({
  region: 'auto',
  endpoint: env('R2_ENDPOINT', 'NUXT_R2_ENDPOINT'),
  credentials: {
    accessKeyId: env('R2_ACCESS_KEY_ID', 'NUXT_R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY', 'NUXT_R2_SECRET_ACCESS_KEY')
  }
})

const LANKA_CORS_ID = 'lanka-dashboard-upload'
const LANKA_LIFECYCLE_ID = 'lanka-expire-staged-uploads'

async function getOr404(cmd) {
  try {
    return await s3.send(cmd)
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode
    if (code === 404 || err?.name === 'NoSuchCORSConfiguration' || err?.name === 'NoSuchLifecycleConfiguration') return null
    throw err
  }
}

// --- CORS: keep every foreign rule, replace ours (matched by ID or by identical origin+PUT) ---
const existingCors = (await getOr404(new GetBucketCorsCommand({ Bucket })))?.CORSRules ?? []
const isOurs = (r) =>
  r.ID === LANKA_CORS_ID ||
  ((r.AllowedOrigins ?? []).length === 1 && r.AllowedOrigins[0] === origin && (r.AllowedMethods ?? []).join() === 'PUT')
const CORSRules = [
  ...existingCors.filter((r) => !isOurs(r)),
  { ID: LANKA_CORS_ID, AllowedOrigins: [origin], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type'], MaxAgeSeconds: 3600 }
]
await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules } }))

// --- Lifecycle: expire staged objects after 1 day; keep foreign rules ---
const existingRules = (await getOr404(new GetBucketLifecycleConfigurationCommand({ Bucket })))?.Rules ?? []
const Rules = [
  ...existingRules.filter((r) => r.ID !== LANKA_LIFECYCLE_ID),
  { ID: LANKA_LIFECYCLE_ID, Status: 'Enabled', Filter: { Prefix: 'uploads/' }, Expiration: { Days: 1 } }
]
await s3.send(new PutBucketLifecycleConfigurationCommand({ Bucket, LifecycleConfiguration: { Rules } }))

const cors = await s3.send(new GetBucketCorsCommand({ Bucket }))
const lifecycle = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))
console.log(`CORS on ${Bucket}:`, JSON.stringify(cors.CORSRules, null, 2))
console.log(`Lifecycle on ${Bucket}:`, JSON.stringify(lifecycle.Rules, null, 2))
