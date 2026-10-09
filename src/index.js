const Database = require('better-sqlite3');

const types = new Map([
  [String, 'string'], [Number, 'number'], [Boolean, 'boolean'], [Date, 'date'],
  ['string', 'string'], ['number', 'number'], ['boolean', 'boolean'],
  ['date', 'date'], ['integer', 'integer'],
]);
const sqlTypes = {
  string: 'TEXT', number: 'REAL', boolean: 'INTEGER', date: 'TEXT', integer: 'INTEGER',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function quoteIdentifier(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new TypeError('Identifiers must be non-empty strings without NUL characters');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

class ModelSchema {
  constructor(tableName, definition) {
    quoteIdentifier(tableName);
    if (!isPlainObject(definition) || Object.keys(definition).length === 0) {
      throw new TypeError('Schema must be a non-empty plain object');
    }
    let primaryKeys = 0;
    this.tableName = tableName;
    this.fields = Object.freeze(Object.fromEntries(Object.entries(definition).map(([name, field]) => {
      quoteIdentifier(name);
      const options = isPlainObject(field) ? field : { type: field };
      const type = types.get(options.type);
      if (!type) throw new TypeError(`Unsupported type for ${name}`);
      for (const option of Object.keys(options)) {
        if (!['type', 'primaryKey', 'autoIncrement', 'required'].includes(option)) {
          throw new TypeError(`Unknown schema option: ${option}`);
        }
        if (option !== 'type' && typeof options[option] !== 'boolean') {
          throw new TypeError(`${option} must be a boolean`);
        }
      }
      const primaryKey = options.primaryKey === true;
      const autoIncrement = options.autoIncrement === true;
      if (primaryKey) primaryKeys += 1;
      if (autoIncrement && (!primaryKey || type !== 'integer')) {
        throw new TypeError('autoIncrement requires an integer primary key');
      }
      return [name, Object.freeze({
        type, primaryKey, autoIncrement, required: primaryKey || options.required === true,
      })];
    })));
    if (primaryKeys > 1) throw new TypeError('Only one primary key is supported');
    Object.freeze(this);
  }

  createTableSQL() {
    const columns = Object.entries(this.fields).map(([name, field]) => {
      return [
        quoteIdentifier(name), sqlTypes[field.type],
        field.primaryKey ? 'PRIMARY KEY' : '',
        field.autoIncrement ? 'AUTOINCREMENT' : '',
        field.required ? 'NOT NULL' : '',
      ].filter(Boolean).join(' ');
    });
    return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.tableName)} (${columns.join(', ')});`;
  }

  encode(name, value) {
    if (!Object.hasOwn(this.fields, name)) throw new TypeError(`Unknown field: ${name}`);
    const field = this.fields[name];
    if (value === null) {
      if (field.required) throw new TypeError(`${name} cannot be null`);
      return null;
    }
    switch (field.type) {
      case 'string':
        if (typeof value === 'string') return value;
        break;
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        break;
      case 'integer':
        if (Number.isSafeInteger(value)) return value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') return value ? 1 : 0;
        break;
      case 'date':
        if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
        break;
    }
    throw new TypeError(`Invalid ${field.type} value for ${name}`);
  }

  decode(row) {
    return Object.fromEntries(Object.keys(this.fields).map((name, index) => {
      let value = row[index];
      if (typeof value === 'bigint') {
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new RangeError(`Integer value for ${name} exceeds the JavaScript safe integer range`);
        }
        value = Number(value);
      }
      if (value !== null && this.fields[name].type === 'boolean') value = value === 1;
      if (value !== null && this.fields[name].type === 'date') value = new Date(value);
      return [name, value];
    }));
  }
}

class StorageEngine {
  #database;

  constructor(filename = 'storage.sqlite') {
    this.#database = new Database(filename);
    this.#database.defaultSafeIntegers(true);
  }

  #checkSchema(schema) {
    if (!(schema instanceof ModelSchema)) throw new TypeError('Expected a ModelSchema');
  }

  #entries(schema, object) {
    this.#checkSchema(schema);
    if (!isPlainObject(object)) throw new TypeError('Values must be a plain object');
    return Object.entries(object).map(([name, value]) => [name, schema.encode(name, value)]);
  }

  #where(entries) {
    if (entries.length === 0) return { sql: '', values: [] };
    return {
      sql: ` WHERE ${entries.map(([name, value]) => (
        `${quoteIdentifier(name)} ${value === null ? 'IS NULL' : '= ?'}`
      )).join(' AND ')}`,
      values: entries.filter(([, value]) => value !== null).map(([, value]) => value),
    };
  }

  #columns(schema) {
    return Object.keys(schema.fields).map(quoteIdentifier).join(', ');
  }

  createTable(schema) {
    this.#checkSchema(schema);
    this.#database.exec(schema.createTableSQL());
    return this;
  }

  insert(schema, object) {
    const entries = this.#entries(schema, object);
    for (const [name, field] of Object.entries(schema.fields)) {
      if (field.required && !field.autoIncrement && !Object.hasOwn(object, name)) {
        throw new TypeError(`Missing required field: ${name}`);
      }
    }
    const columns = entries.map(([name]) => quoteIdentifier(name)).join(', ');
    const placeholders = entries.map(() => '?').join(', ');
    const valuesSQL = entries.length ? `(${columns}) VALUES (${placeholders})` : 'DEFAULT VALUES';
    return this.#database.transaction(() => {
      const row = this.#database.prepare(
        `INSERT INTO ${quoteIdentifier(schema.tableName)} ${valuesSQL} RETURNING ${this.#columns(schema)}`,
      ).raw().get(...entries.map(([, value]) => value));
      return schema.decode(row);
    })();
  }

  select(schema, filter = {}) {
    const where = this.#where(this.#entries(schema, filter));
    return this.#database.prepare(
      `SELECT ${this.#columns(schema)} FROM ${quoteIdentifier(schema.tableName)}${where.sql}`,
    ).raw().all(...where.values).map((row) => schema.decode(row));
  }

  update(schema, filter, changes) {
    const where = this.#where(this.#entries(schema, filter));
    const entries = this.#entries(schema, changes);
    if (!where.sql || entries.length === 0) {
      throw new TypeError('Update requires a non-empty filter and changes');
    }
    const assignments = entries.map(([name]) => `${quoteIdentifier(name)} = ?`).join(', ');
    return this.#database.transaction(() => this.#database.prepare(
      `UPDATE ${quoteIdentifier(schema.tableName)} SET ${assignments}${where.sql} RETURNING ${this.#columns(schema)}`,
    ).raw().all(...entries.map(([, value]) => value), ...where.values).map((row) => schema.decode(row)))();
  }

  delete(schema, filter) {
    const where = this.#where(this.#entries(schema, filter));
    if (!where.sql) throw new TypeError('Delete requires a non-empty filter');
    return this.#database.prepare(
      `DELETE FROM ${quoteIdentifier(schema.tableName)}${where.sql}`,
    ).run(...where.values).changes;
  }

  close() {
    this.#database.close();
  }
}

module.exports = { ModelSchema, StorageEngine };
