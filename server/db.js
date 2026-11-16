import { DatabaseSync } from 'node:sqlite';

// All money columns are integers in 1/100 of the user's currency unit.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'IDR',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  opening INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  to_wallet_id INTEGER REFERENCES wallets(id),
  type TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  import_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS tx_user_date ON transactions(user_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS tx_import ON transactions(user_id, import_hash);
CREATE TABLE IF NOT EXISTS budgets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  monthly_limit INTEGER NOT NULL,
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target INTEGER NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0,
  due TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  number TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_contact TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  total INTEGER NOT NULL,
  due TEXT,
  instructions TEXT NOT NULL DEFAULT '',
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  status TEXT NOT NULL DEFAULT 'unpaid',
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS waitlist (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
