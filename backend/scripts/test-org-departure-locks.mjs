// Disposable local database only. Two sessions prove affected-root locking
// without taking a tuple lock on every other item in the organization.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
const container = process.env.MIKE_TEST_POSTGRES_CONTAINER;
const database = process.env.MIKE_TEST_POSTGRES_DATABASE;
const url = new URL(process.env.SUPABASE_TEST_DB_URL ?? "postgres://invalid");
if (container ? !database?.startsWith("mike_sql_") : !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("Use a disposable loopback database or an explicitly named mike_sql_ test database");
}
const command = container ? "docker" : "psql";
const args = container ? ["exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-XAtq", "-v", "ON_ERROR_STOP=1"] : ["-XAtq", "-v", "ON_ERROR_STOP=1"];
const env = container ? process.env : { ...process.env, PGHOST: url.hostname.replace(/[\[\]]/g, ""), PGPORT: url.port || "5432", PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: "10" };
function session() {
  const child = spawn(command, args, { env });
  let output = "", error = "";
  const listeners = new Set();
  child.stdout.on("data", d => { output += d; for (const fn of listeners) fn(); });
  child.stderr.on("data", d => { error += d; });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(error || `psql exited ${code}`))); });
  // Observe rejection even while a marker is awaited; the caller still gets it.
  done.catch(() => {});
  return { write: sql => child.stdin.write(sql + "\n"), end: sql => child.stdin.end((sql ?? "") + "\n"), done,
    marker: text => Promise.race([new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Missing marker ${text}`)), 15000);
      const check = () => { if (output.includes(text)) { clearTimeout(timeout); listeners.delete(check); resolve(); } };
      listeners.add(check); check();
    }), done.then(() => { throw new Error(`Session ended before ${text}`); })]) };
}
async function query(sql) { const s = session(); s.end(`set statement_timeout='15s';\n${sql}`); return s.done; }
const owner = randomUUID(), departing = randomUUID(), second = randomUUID(), remaining = randomUUID(), third = randomUUID(), fourth = randomUUID(), fifth = randomUUID(), org = randomUUID();
const affected = randomUUID(), unrelated = randomUUID(), shared = randomUUID(), doc = randomUUID(), chat = randomUUID(), review = randomUUID();
let held;
try {
  await query(`insert into auth.users(id,email) values ${[owner,departing,second,remaining,third,fourth,fifth].map(id => `('${id}','${id}@example.test')`).join(",")};
    insert into organizations(id,name,created_by) values('${org}','Departure locks','${owner}');
    insert into org_members(org_id,user_id,role) values('${org}','${owner}','owner'),('${org}','${departing}','member'),('${org}','${second}','member'),('${org}','${remaining}','member'),('${org}','${third}','member'),('${org}','${fourth}','member'),('${org}','${fifth}','member');
    insert into projects(id,org_id,user_id,name) values('${affected}','${org}','${departing}','Affected'),('${unrelated}','${org}','${remaining}','Unrelated'),('${shared}','${org}','${second}','Concurrent sharing');
    insert into projects(org_id,user_id,name) select '${org}','${remaining}','Unrelated '||n from generate_series(1,1000) n;
    insert into documents(id,org_id,user_id) values('${doc}','${org}','${departing}');
    insert into chats(id,org_id,user_id,title) values('${chat}','${org}','${remaining}','Retained chat');
    insert into tabular_reviews(id,org_id,user_id,title) values('${review}','${org}','${remaining}','Retained review');
    insert into chat_messages(chat_id,role,files) values('${chat}','user','[{"document_id":"${doc}"}]');`);
  held = session();
  held.write(`begin; set local statement_timeout='15s'; select remove_org_member('${org}','${departing}','${owner}');\n\\echo DEPARTED`);
  await held.marker("DEPARTED");
  // A row-only lock on unrelated work succeeds while the departure is open.
  // Ordinary writes can still wait on the intentionally retained org fence.
  await query(`begin; select id from projects where id='${unrelated}' for update nowait; rollback;`);
  await assert.rejects(query(`begin; select id from projects where id='${affected}' for update nowait; rollback;`), /could not obtain lock/);
  held.end("commit;"); await held.done; held = null;
  assert.equal(await query(`select archived_at is not null from projects where id='${affected}';`), "t");
  assert.equal(await query(`select archived_at is null and user_id='${owner}' from documents where id='${doc}';`), "t");
  // With no owned documents, unrelated reference roots stay unlocked too.
  held = session();
  held.write(`begin; select remove_org_member('${org}','${second}','${owner}');\n\\echo NO_DOCUMENTS`);
  await held.marker("NO_DOCUMENTS");
  await query(`begin; select id from chats where id='${chat}' for update nowait; select id from tabular_reviews where id='${review}' for update nowait; rollback;`);
  held.end("rollback;"); await held.done; held = null;
  // A grant which wins the parent lock must affect departure classification.
  held = session();
  held.write(`begin; insert into project_org_access_overrides(project_id,org_id,user_id,role) values('${shared}','${org}','${remaining}','editor');\n\\echo SHARED`);
  await held.marker("SHARED");
  const application = `mike_departure_${randomUUID()}`;
  const departure = query(`set application_name='${application}'; select remove_org_member('${org}','${second}','${owner}');`);
  let waiting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    waiting = await query(`select exists(select 1 from pg_stat_activity where application_name='${application}' and wait_event_type='Lock');`) === "t";
    if (waiting) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(waiting, "departure must wait for the in-flight sharing write before classifying the affected root");
  held.end("commit;"); await held.done; held = null; await departure;
  assert.equal(await query(`select archived_at is null and exists(select 1 from project_org_access_overrides where project_id='${shared}' and user_id='${owner}' and role='owner') from projects where id='${shared}';`), "t");
  assert.equal(await query(`select role from project_org_access_overrides where project_id='${shared}' and user_id='${remaining}';`), "editor");
  // JSON references have no document FK lock. Departure must wait for the
  // retained chat's message transaction, then transfer the now-referenced doc.
  // Repeat with a document that becomes standalone inside that transaction;
  // the fence decision cannot rely on its pre-commit project placement.
  for (const [actor, moving, kind] of [[third, false, "chat"], [fourth, true, "chat"], [fifth, false, "review"]]) {
    const referenced = randomUUID();
    await query(`insert into documents(id,org_id,user_id,project_id) values('${referenced}','${org}','${actor}',${moving ? `'${unrelated}'` : "null"});`);
    held = session();
    held.write(`begin; ${moving ? `update documents set project_id=null where id='${referenced}';` : ""}
      ${kind === "chat" ? `insert into chat_messages(chat_id,role,files) values('${chat}','user','[{"document_id":"${referenced}"}]');` : `update tabular_reviews set document_ids=jsonb_build_array('${referenced}'::text) where id='${review}';`}\n\\echo REFERENCED`);
    await held.marker("REFERENCED");
    const application = `mike_reference_${randomUUID()}`;
    const departure = query(`set application_name='${application}'; select remove_org_member('${org}','${actor}','${owner}');`);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = await query(`select exists(select 1 from pg_stat_activity where application_name='${application}' and wait_event_type='Lock');`) === "t";
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting, "departure waits for uncommitted retained chat/review JSON references, including moved documents");
    held.end("commit;"); await held.done; held = null; await departure;
    assert.equal(await query(`select archived_at is null and user_id='${owner}' and project_id is null from documents where id='${referenced}';`), "t");
  }
  console.log("Departure locks: unrelated roots stay unlocked; affected roots, grants and concurrent JSON references retain lifecycle protection.");
} finally {
  if (held) { held.end("rollback;"); await held.done.catch(() => {}); }
  await query(`delete from documents where org_id='${org}'; delete from tabular_reviews where org_id='${org}'; delete from chats where org_id='${org}'; delete from projects where org_id='${org}'; delete from organizations where id='${org}'; delete from auth.users where id in (${[owner,departing,second,remaining,third,fourth,fifth].map(id => `'${id}'`).join(",")});`);
}
