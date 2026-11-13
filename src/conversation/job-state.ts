export interface LegacyAlarmMigration {
  version: 1
  dueAt: number | null
  scheduled: boolean
  consumed: boolean
}

export const LEGACY_ALARM_MIGRATION_KEY = "lifecycleLegacyAlarmMigration"

export function isFreshLegacyAlarmMigration(value: unknown): value is LegacyAlarmMigration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 4 && record.version === 1 && record.dueAt === null &&
    record.scheduled === false && record.consumed === true
}
