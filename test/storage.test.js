const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Database = require('better-sqlite3');
const { ModelSchema, StorageEngine } = require('..');

const users = new ModelSchema('users', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: String, required: true },
  score: Number,
  active: Boolean,
  createdAt: Date,
});

function setup(t, schema = users) {
  const storage = new StorageEngine(':memory:');
  t.after(() => storage.close());
  storage.createTable(schema);
  return storage;
}

test('DDL maps all supported types and constraints', () => {
  assert.equal(users.createTableSQL(), 'CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "score" REAL, "active" INTEGER, "createdAt" TEXT);');
  const database = new Database(':memory:');
  try {
    database.exec(users.createTableSQL());
    const columns = database.pragma('table_info(users)');
    assert.deepEqual(columns.map(({ type }) => type), ['INTEGER', 'TEXT', 'REAL', 'INTEGER', 'TEXT']);
    assert.equal(columns[0].pk, 1);
    assert.equal(columns[1].notnull, 1);
  } finally {
    database.close();
  }
});

test('CRUD round-trips Plain JS Objects, booleans, dates and numbers', (t) => {
  const storage = setup(t);
  storage.createTable(users);
  const data = { name: 'Alice', score: 1.25, active: true, createdAt: new Date('2026-01-01T00:00:00Z') };
  const user = storage.insert(users, data);
  assert.deepEqual(user, { id: 1, ...data });
  assert.equal(Object.getPrototypeOf(user), Object.prototype);
  assert.deepEqual(storage.select(users), [user]);
  assert.deepEqual(storage.select(users, { active: true, createdAt: data.createdAt }), [user]);
  assert.deepEqual(storage.update(users, { id: user.id }, { active: false, score: 2.5 }), [
    { ...user, active: false, score: 2.5 },
  ]);
  assert.deepEqual(data, { name: 'Alice', score: 1.25, active: true, createdAt: data.createdAt });
  assert.equal(storage.delete(users, { id: user.id }), 1);
  assert.deepEqual(storage.select(users), []);
  assert.equal(storage.delete(users, { id: user.id }), 0);
  assert.deepEqual(storage.update(users, { id: user.id }, { name: 'Nobody' }), []);
});

test('nullable fields, multi-field filters and multiple matching rows work', (t) => {
  const storage = setup(t);
  const first = storage.insert(users, { name: 'Alice' });
  storage.insert(users, { name: 'Alice', score: null, active: false });
  storage.insert(users, { name: 'Bob', score: 3 });
  assert.deepEqual(first, { id: 1, name: 'Alice', score: null, active: null, createdAt: null });
  assert.equal(storage.select(users, { name: 'Alice', score: null }).length, 2);
  assert.equal(storage.update(users, { name: 'Alice', score: null }, { score: 5 }).length, 2);
  assert.equal(storage.delete(users, { name: 'Alice', score: 5 }), 2);
  assert.equal(storage.select(users).length, 1);
});

test('empty inserts use default values for auto-generated and nullable fields', (t) => {
  const schema = new ModelSchema('defaults', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true }, note: String,
  });
  const storage = setup(t, schema);
  assert.deepEqual(storage.insert(schema, {}), { id: 1, note: null });
});

test('user and article models can share a database', (t) => {
  const storage = setup(t);
  const articles = new ModelSchema('articles', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    authorId: 'integer', title: String, published: Boolean,
  });
  storage.createTable(articles);
  const user = storage.insert(users, { name: 'Alice' });
  const article = storage.insert(articles, { authorId: user.id, title: 'Hello', published: false });
  assert.deepEqual(storage.select(articles, { authorId: user.id }), [article]);
  assert.deepEqual(storage.select(users), [user]);
});

test('data persists after closing and reopening a single SQLite file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dynamic-storage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'storage.sqlite');
  const storage = new StorageEngine(filename);
  let user;
  try {
    storage.createTable(users);
    user = storage.insert(users, { name: 'Persisted', active: false, createdAt: new Date() });
  } finally {
    storage.close();
  }
  const reopened = new StorageEngine(filename);
  try {
    reopened.createTable(users);
    assert.deepEqual(reopened.select(users), [user]);
  } finally {
    reopened.close();
  }
});

test('values and quoted identifiers cannot inject SQL', (t) => {
  const column = 'name"; DROP TABLE users; --';
  const schema = new ModelSchema('table"; DROP TABLE users; --', {
    [column]: String, select: String,
  });
  const storage = setup(t);
  storage.createTable(schema);
  const value = "'; DROP TABLE users; --";
  const row = storage.insert(schema, { [column]: value, select: 'reserved' });
  assert.deepEqual(storage.select(schema, { [column]: value }), [row]);
  assert.deepEqual(storage.update(schema, { [column]: value }, { select: 'updated' }), [
    { ...row, select: 'updated' },
  ]);
  assert.equal(storage.delete(schema, { [column]: value }), 1);
  assert.deepEqual(storage.select(users), []);
  assert.throws(() => storage.select(users, { [column]: value }), /Unknown field/);
});

test('special object property names are supported without prototype pollution', (t) => {
  const schema = new ModelSchema('special', JSON.parse('{"__proto__":"string","constructor":"string"}'));
  const storage = setup(t, schema);
  const row = JSON.parse('{"__proto__":"value","constructor":"text"}');
  assert.deepEqual(storage.insert(schema, row), row);
  assert.deepEqual(storage.select(schema, row), [row]);
  assert.deepEqual(storage.update(schema, row, { constructor: 'updated' }), [
    { ...row, constructor: 'updated' },
  ]);
  assert.equal(Object.getPrototypeOf(schema.fields), Object.prototype);
});

test('column order in an existing table does not affect type decoding', (t) => {
  const storage = setup(t);
  const user = storage.insert(users, { name: 'Alice', active: true, createdAt: new Date() });
  const reordered = new ModelSchema('users', Object.fromEntries(Object.entries(users.fields).reverse()));
  storage.createTable(reordered);
  assert.deepEqual(storage.select(reordered), [user]);
  assert.deepEqual(storage.update(reordered, { id: user.id }, { active: false }), [
    { ...user, active: false },
  ]);
  const second = storage.insert(reordered, { name: 'Bob' });
  assert.equal(second.id, 2);
  assert.equal(second.name, 'Bob');
});

test('invalid schemas and unsupported options fail early', () => {
  for (const name of ['', 'bad\0name', 123]) {
    assert.throws(() => new ModelSchema(name, { name: String }), TypeError);
  }
  for (const definition of [
    {}, [], null, { name: Object }, { name: { type: String, required: 'yes' } },
    { name: { type: String, default: 'value' } }, { '': String }, { 'bad\0name': String },
    { id: { type: Number, primaryKey: true, autoIncrement: true } },
    { id: { type: 'integer', autoIncrement: true } },
    { a: { type: String, primaryKey: true }, b: { type: String, primaryKey: true } },
  ]) {
    assert.throws(() => new ModelSchema('invalid', definition), TypeError);
  }
});

test('unknown fields and invalid values are rejected across CRUD operations', (t) => {
  const storage = setup(t);
  storage.insert(users, { name: 'Alice' });
  for (const values of [
    { unknown: 'x' }, { name: undefined }, { name: 123 }, { name: null },
    { score: NaN }, { score: Infinity }, { score: '1' }, { active: 1 },
    { createdAt: '2026-01-01' }, { createdAt: new Date('invalid') },
    { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: null },
  ]) {
    assert.throws(() => storage.insert(users, { name: 'Alice', ...values }), TypeError);
    assert.throws(() => storage.select(users, values), TypeError);
    assert.throws(() => storage.update(users, { id: 1 }, values), TypeError);
    assert.throws(() => storage.delete(users, values), TypeError);
  }
  assert.throws(() => storage.insert(users, {}), /Missing required field/);
  for (const value of [null, [], new Date(), 'text']) {
    assert.throws(() => storage.insert(users, value), TypeError);
    assert.throws(() => storage.select(users, value), TypeError);
  }
  assert.throws(() => storage.createTable({}), /ModelSchema/);
  assert.equal(storage.select(users).length, 1);
});

test('updates and deletes refuse empty filters or empty changes', (t) => {
  const storage = setup(t);
  storage.insert(users, { name: 'Alice' });
  assert.throws(() => storage.update(users, {}, { name: 'Bob' }), /non-empty/);
  assert.throws(() => storage.update(users, { id: 1 }, {}), /non-empty/);
  assert.throws(() => storage.delete(users, {}), /non-empty/);
  assert.throws(() => storage.delete(users), TypeError);
  assert.equal(storage.select(users)[0].name, 'Alice');
});

test('primary keys enforce uniqueness and schema definitions are immutable', (t) => {
  const definition = { key: { type: String, primaryKey: true }, label: 'string' };
  const schema = new ModelSchema('keys', definition);
  definition.key.type = Number;
  definition.other = String;
  assert.equal(schema.fields.key.type, 'string');
  assert.equal(Object.isFrozen(schema), true);
  assert.equal(Object.isFrozen(schema.fields), true);
  assert.equal(Object.isFrozen(schema.fields.key), true);
  const storage = setup(t, schema);
  storage.insert(schema, { key: 'unique' });
  assert.throws(() => storage.insert(schema, { key: 'unique' }), /UNIQUE constraint/);
  assert.throws(() => storage.insert(schema, {}), /Missing required field/);
});

test('out-of-range generated IDs fail without rounding or persisting a row', (t) => {
  const storage = setup(t);
  const user = storage.insert(users, { id: Number.MAX_SAFE_INTEGER, name: 'Last safe ID' });
  assert.equal(user.id, Number.MAX_SAFE_INTEGER);
  assert.throws(() => storage.insert(users, { name: 'Overflow' }), /safe integer range/);
  assert.throws(() => storage.insert(users, { name: 'Still overflow' }), /safe integer range/);
  assert.deepEqual(storage.select(users, { id: user.id }), [user]);
  assert.deepEqual(storage.select(users), [user]);
});
