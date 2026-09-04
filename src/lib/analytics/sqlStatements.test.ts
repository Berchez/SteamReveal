import path from 'path';
import fs from 'fs';
import splitSqlStatements from './sqlStatements';

describe('splitSqlStatements', () => {
  it('splits on semicolons and drops line comments', () => {
    const sql = `
      -- header comment
      CREATE TABLE t1 (a INTEGER);   -- trailing comment
      CREATE TABLE t2 (label TEXT);

      -- comment-only chunk with no statement
      ;
      CREATE TABLE t3 (note TEXT);
    `;

    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE t1 (a INTEGER)',
      'CREATE TABLE t2 (label TEXT)',
      'CREATE TABLE t3 (note TEXT)',
    ]);
  });

  it('ignores semicolons and comment markers inside string literals', () => {
    const sql = `
      CREATE TABLE t (v TEXT);
      INSERT INTO t (v) VALUES ('a;b -- c');
    `;

    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[1]).toBe("INSERT INTO t (v) VALUES ('a;b -- c')");
  });

  it('handles a trailing statement without a final semicolon', () => {
    expect(splitSqlStatements('CREATE TABLE t (a INTEGER);SELECT 1')).toEqual([
      'CREATE TABLE t (a INTEGER)',
      'SELECT 1',
    ]);
  });

  it('returns an empty array for comment-only or empty input', () => {
    expect(splitSqlStatements('-- just a comment\n-- another')).toEqual([]);
    expect(splitSqlStatements('   ')).toEqual([]);
  });

  it('parses the real 001_init.sql into its statements', () => {
    const filePath = path.resolve(__dirname, 'migrations', '001_init.sql');
    const sql = fs.readFileSync(filePath, 'utf-8');

    const statements = splitSqlStatements(sql);

    // 7 CREATE TABLEs + 3 CREATE INDEXes.
    expect(statements).toHaveLength(10);
    expect(statements).toHaveLength(
      statements.filter((s) => s.startsWith('CREATE TABLE')).length +
        statements.filter((s) => s.startsWith('CREATE INDEX')).length,
    );
    statements.forEach((statement) => {
      expect(statement).not.toContain('--');
      expect(statement).toMatch(/^CREATE (TABLE|INDEX)/);
    });
  });
});