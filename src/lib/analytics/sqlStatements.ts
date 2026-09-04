/**
 * Splits a SQL script file into standalone statements.
 *
 * Migration files are applied through `db.batch()` so the whole file (DDL +
 * the `_migrations` bookkeeping row) commits or rolls back atomically. Unlike
 * the driver's `executeMultiple()`, `batch()` does NOT split on `;` — each
 * array element is one statement — so the split has to happen here.
 *
 * The splitter understands SQLite line comments (`--` … EOL) and
 * single-quoted string literals, so a `;` or `--` inside a string value can
 * never terminate (or comment out) an unrelated statement. Block comments are
 * not used in this repo's migrations.
 */
const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const isLineComment = ch === '-' && sql[i + 1] === '-';

    if (!inSingleQuote && isLineComment) {
      // Skip to end of line.
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
    } else if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i += 1;
    } else if (!inSingleQuote && ch === ';') {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = '';
      i += 1;
    } else {
      current += ch;
      i += 1;
    }
  }

  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
};

export default splitSqlStatements;