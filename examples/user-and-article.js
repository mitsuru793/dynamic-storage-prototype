const { ModelSchema, StorageEngine } = require('..');

const users = new ModelSchema('users', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: String, required: true },
  email: String,
  active: Boolean,
  createdAt: Date,
});

const articles = new ModelSchema('articles', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  authorId: { type: 'integer', required: true },
  title: { type: String, required: true },
  body: String,
  published: Boolean,
});

const storage = new StorageEngine(process.argv[2] || 'example.sqlite');
try {
  storage.createTable(users).createTable(articles);
  const user = storage.insert(users, {
    name: 'Alice', email: 'alice@example.com', active: true, createdAt: new Date(),
  });
  const article = storage.insert(articles, {
    authorId: user.id, title: 'Hello SQLite', body: 'Plain JS Objectから保存', published: false,
  });
  console.log('User:', user);
  console.log('Articles:', storage.select(articles, { authorId: user.id }));
  console.log('Updated:', storage.update(articles, { id: article.id }, { published: true }));
  console.log('Deleted:', storage.delete(articles, { id: article.id }));
} finally {
  storage.close();
}
