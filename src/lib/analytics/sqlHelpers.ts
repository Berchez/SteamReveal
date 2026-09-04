/**
 * Small SQLite value converters shared by the Turso analytics DAL and the
 * data-migration script (they must agree on how JS values map to SQL
 * columns).
 */

/** Converts a JS boolean to SQLite INTEGER conventions (1 / 0 / NULL). */
export const toSqlBool = (v: boolean | null | undefined): number | null => {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
};

/**
 * Coerces a value to TEXT for a SQLite TEXT column, keeping NULL for absent
 * values. Used for fields that are declared TEXT in the schema but arrive as
 * numbers in the client JSON payload (e.g. ProfileRecord.cityId, which is
 * numeric in the real analytics-data.json).
 */
export const nullableText = (
  v: string | number | null | undefined,
): string | null => {
  if (v === null || v === undefined) {
    return null;
  }
  return String(v);
};