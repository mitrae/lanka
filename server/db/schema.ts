// server/db/schema.ts
import { sql, relations } from 'drizzle-orm'
import {
  sqliteTable,
  integer,
  text,
  check,
  uniqueIndex
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
    .default(sql`(unixepoch() * 1000)`)
})

export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sha256: text('sha256').notNull(),
    kind: text('kind', { enum: ['video', 'image'] }).notNull(),
    filename: text('filename').notNull(),
    bytes: integer('bytes').notNull(),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    sha256Idx: uniqueIndex('media_sha256_idx').on(t.sha256)
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
