# dynamic-storage-prototype
Plain JS ObjectのモデルからSQLiteのDDL/CRUDを動的生成するプロトタイプ

## セットアップ

Node.js 22以上が必要です。SQLiteサーバーのセットアップは不要で、
`better-sqlite3`を利用して単一ファイルに保存します。
環境によってはネイティブモジュールのビルド用ツールが必要になります。

```sh
npm install
npm test
npm run example
```

使用例は`examples/user-and-article.js`です。`example.sqlite`が作成されます。
別の保存先は`npm run example -- /tmp/example.sqlite`で指定できます。

## 使用方法

```js
const { ModelSchema, StorageEngine } = require('./');

const users = new ModelSchema('users', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: String, required: true },
  score: Number,
  active: Boolean,
  createdAt: Date,
});

console.log(users.createTableSQL()); // CREATE TABLE文
const storage = new StorageEngine('app.sqlite'); // ':memory:'も使用可能
try {
  storage.createTable(users);
  const user = storage.insert(users, {
    name: 'Alice', score: 1.5, active: true, createdAt: new Date(),
  });
  console.log(storage.select(users, { id: user.id }));
  console.log(storage.update(users, { id: user.id }, { active: false }));
  console.log(storage.delete(users, { id: user.id }));
} finally {
  storage.close();
}
```

### スキーマ・型

| JSの型定義 | SQLite型 | 保存・読み込み |
| --- | --- | --- |
| `String` / `'string'` | TEXT | 文字列 |
| `Number` / `'number'` | REAL | 有限の数値 |
| `'integer'` | INTEGER | JavaScriptの安全な整数 |
| `Boolean` / `'boolean'` | INTEGER | 0/1で保存しbooleanで返却 |
| `Date` / `'date'` | TEXT | UTCのISO文字列で保存しDateで返却 |

各フィールドは型だけ、または`{ type, required, primaryKey, autoIncrement }`で指定します。
`required`はNOT NULL、`primaryKey`は単一の主キー（NOT NULL）です。
`autoIncrement`は`'integer'`の主キーにのみ指定できます。
主キー以外のフィールドは既定でNULL許可です。省略した任意フィールドはNULLで返却されます。
`null`はNULL許可フィールドのみ使用でき、`undefined`、未知のフィールド、
型違い、無効なDateは拒否されます。オブジェクトや配列の保存は対象外です。

### CRUD

- `createTable(schema)`: `CREATE TABLE IF NOT EXISTS`を実行し、エンジンを返します。
- `insert(schema, object)`: 保存後のPlain JS Object（生成されたIDを含む）を返します。
- `select(schema, filter = {})`: 一致するオブジェクトの配列を返します。条件省略で全件取得。
- `update(schema, filter, changes)`: 更新後のオブジェクトの配列を返します。
- `delete(schema, filter)`: 削除件数を返します。
- `close()`: 接続を閉じます。

条件はフィールドの等価比較をANDで結合します。`null`の条件は`IS NULL`になります。
UPDATE・DELETEは空の条件を拒否します。値はプレースホルダーにバインドし、
テーブル名・カラム名は引用・エスケープします。取得順序は保証しません。

プロトタイプ向けのため、既存テーブルのスキーマ変更（マイグレーション）、
関連・外部キーの自動生成、複雑な検索、非同期APIは提供しません。
スキーマ変更時は別のDBファイルを使用するか、別途マイグレーションしてください。
