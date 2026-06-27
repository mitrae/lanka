// server/db/schema.ts
import { sql, relations } from 'drizzle-orm'
import {
  sqliteTable,
  integer,
  text,
  check,
  uniqueIndex,
  index
} from 'drizzle-orm/sqlite-core'

export const addresses = sqliteTable('addresses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const groups = sqliteTable('groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  addressId: integer('address_id')
    .notNull()
    .references(() => addresses.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(), // device-generated (Android ID or UUID)
  groupId: integer('group_id').references(() => groups.id, { onDelete: 'set null' }),
  name: text('name'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  playerVersion: text('player_version'),
  // No FK on currentItemId — SQLite can't express a circular FK cleanly
  // (devices→playlistItems→playlists). Orphan cleanup is the playlist/item
  // delete handler's job: null this column whenever the referenced item dies.
  currentItemId: integer('current_item_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  apkVersion: text('apk_version')
})

export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull(),
    kind: text('kind', { enum: ['video', 'image'] }).notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    bytes: integer('bytes').notNull(),
    thumbnailBytes: integer('thumbnail_bytes'),
    playCount: integer('play_count').notNull().default(0),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    organizationId: integer('organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' }
    ),
    sourceSha256: text('source_sha256'),
  },
  (t) => ({
    sha256Idx: uniqueIndex('media_sha256_idx').on(t.sha256),
    sourceShaIdx: index('media_source_sha_idx').on(t.sourceSha256)
  })
)

export const playlists = sqliteTable('playlists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const playlistItems = sqliteTable(
  'playlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    mediaId: integer('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    durationMsOverride: integer('duration_ms_override')
  },
  (t) => ({
    posIdx: uniqueIndex('playlist_items_pos_idx').on(t.playlistId, t.position)
  })
)

export const assignments = sqliteTable(
  'assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    groupId: integer('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    addressId: integer('address_id').references(() => addresses.id, {
      onDelete: 'cascade'
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceIdx: uniqueIndex('assignments_device_idx').on(t.deviceId),
    groupIdx: uniqueIndex('assignments_group_idx').on(t.groupId),
    addressIdx: uniqueIndex('assignments_address_idx').on(t.addressId),
    exactlyOne: check(
      'assignments_exactly_one_target',
      sql`(("device_id" IS NOT NULL) + ("group_id" IS NOT NULL) + ("address_id" IS NOT NULL)) = 1`
    )
  })
)

export const deviceErrors = sqliteTable(
  'device_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    sha256: text('sha256'),
    message: text('message').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceIdx: index('device_errors_device_idx').on(t.deviceId, t.createdAt)
  })
)

export const apkReleases = sqliteTable('apk_releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull(),
  sha256: text('sha256').notNull().unique(),
  size: integer('size').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' })
})

export const deviceCommands = sqliteTable(
  'device_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    cmd: text('cmd', { enum: ['ota', 'reboot', 'screenshot', 'log-request', 'kiosk-lock', 'kiosk-unlock'] }).notNull(),
    payload: text('payload'),
    status: text('status', { enum: ['pending', 'sent', 'acked', 'failed'] })
      .notNull()
      .default('pending'),
    result: text('result'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    deviceStatusIdx: index('device_commands_device_status_idx').on(t.deviceId, t.status)
  })
)

export const organizations = sqliteTable('organizations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['super', 'admin', 'client'] }).notNull(),
    organizationId: integer('organization_id').references(() => organizations.id, {
      onDelete: 'cascade'
    }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
    roleOrg: check(
      'users_role_org_chk',
      sql`(("role" = 'client' AND "organization_id" IS NOT NULL) OR ("role" IN ('super','admin') AND "organization_id" IS NULL))`
    )
  })
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(rawCookieToken)
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId)
  })
)

// Relations (used by Drizzle query API)
export const addressesRelations = relations(addresses, ({ many }) => ({
  groups: many(groups),
  assignments: many(assignments)
}))
export const groupsRelations = relations(groups, ({ one, many }) => ({
  address: one(addresses, { fields: [groups.addressId], references: [addresses.id] }),
  devices: many(devices),
  assignments: many(assignments)
}))
export const devicesRelations = relations(devices, ({ one, many }) => ({
  group: one(groups, { fields: [devices.groupId], references: [groups.id] }),
  assignments: many(assignments)
}))
export const playlistsRelations = relations(playlists, ({ many }) => ({
  items: many(playlistItems),
  assignments: many(assignments)
}))
export const playlistItemsRelations = relations(playlistItems, ({ one }) => ({
  playlist: one(playlists, {
    fields: [playlistItems.playlistId],
    references: [playlists.id]
  }),
  media: one(media, { fields: [playlistItems.mediaId], references: [media.id] })
}))
export const assignmentsRelations = relations(assignments, ({ one }) => ({
  playlist: one(playlists, {
    fields: [assignments.playlistId],
    references: [playlists.id]
  }),
  device: one(devices, { fields: [assignments.deviceId], references: [devices.id] }),
  group: one(groups, { fields: [assignments.groupId], references: [groups.id] }),
  address: one(addresses, {
    fields: [assignments.addressId],
    references: [addresses.id]
  })
}))
export const deviceErrorsRelations = relations(deviceErrors, ({ one }) => ({
  device: one(devices, { fields: [deviceErrors.deviceId], references: [devices.id] })
}))
export const apkReleasesRelations = relations(apkReleases, ({ one }) => ({
  uploadedBy: one(users, { fields: [apkReleases.uploadedBy], references: [users.id] })
}))
export const deviceCommandsRelations = relations(deviceCommands, ({ one }) => ({
  device: one(devices, { fields: [deviceCommands.deviceId], references: [devices.id] })
}))
export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  media: many(media)
}))
export const usersRelations = relations(users, ({ one }) => ({
  organization: one(organizations, {
    fields: [users.organizationId],
    references: [organizations.id]
  })
}))
export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] })
}))

export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(), // sha256(rawToken)
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    userIdx: index('password_reset_tokens_user_idx').on(t.userId)
  })
)

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] })
}))

export const mediaRelations = relations(media, ({ one }) => ({
  organization: one(organizations, {
    fields: [media.organizationId],
    references: [organizations.id]
  })
}))
