// Applying a SQL file through the pure-JS `pg` client.
//
// The bundled Postgres ships no psql, so schema.sql and every migration file
// go through `client.query(text)`: the simple protocol accepts a multi-
// statement string, but runs the whole string as ONE implicit transaction.
// That is the behaviour a migration runner wants (all-or-nothing per file)
// right up until a file contains a statement Postgres refuses to run inside
// a transaction block — `CREATE/DROP INDEX CONCURRENTLY`, `VACUUM`, `ALTER
// TYPE … ADD VALUE` (pre-12), `CREATE DATABASE`. psql -f does not hit this
// because it sends statements one at a time in autocommit mode.
//
// Strategy: try the file the transactional way first. If Postgres answers
// with SQLSTATE 25001 (active_sql_transaction, "cannot run inside a
// transaction block"), the implicit transaction has already been rolled
// back, so nothing is half-applied; replay the file statement by statement,
// each in its own autocommit transaction — exactly what psql would have done.

const TRANSACTION_BLOCK_ERROR = "25001";

// Split a SQL text into top-level statements on `;`, honouring everything
// that can legally contain a semicolon: single-quoted strings (with ''
// and E'\'' escapes), double-quoted identifiers, `-- line` comments,
// nestable `/* block */` comments and `$tag$ … $tag$` dollar quoting
// (function bodies). Statements that are only whitespace/comments are
// dropped; leading comments stay attached to the statement that follows.
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? n : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      do {
        if (sql.startsWith("/*", j)) { depth += 1; j += 2; }
        else if (sql.startsWith("*/", j)) { depth -= 1; j += 2; }
        else j += 1;
      } while (depth > 0 && j < n);
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "'") {
      const escaped = /[eE]$/.test(current) && !/[A-Za-z0-9_]{2}$/.test(current);
      let j = i + 1;
      while (j < n) {
        if (escaped && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const stop = close === -1 ? n : close + tag[0].length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements
    .map((s) => s.trim())
    .filter((s) => stripComments(s).trim().length > 0);
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Run one SQL file through `query(text)` (a `pg` Client's query, or any
 * function with that contract). Returns how it was applied so callers/tests
 * can tell the two paths apart.
 */
async function runSqlFile(query, sql) {
  try {
    await query(sql);
    return { mode: "transaction", statements: 1 };
  } catch (err) {
    if (err?.code !== TRANSACTION_BLOCK_ERROR) throw err;
  }
  const statements = splitStatements(sql);
  for (const statement of statements) {
    await query(statement);
  }
  return { mode: "autocommit", statements: statements.length };
}

module.exports = { splitStatements, runSqlFile, TRANSACTION_BLOCK_ERROR };
