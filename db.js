const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath);

// Initialize tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    google_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    video_url TEXT NOT NULL,
    is_clip BOOLEAN NOT NULL DEFAULT 0,
    uploaded_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS backlog (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    video_url TEXT NOT NULL,
    is_clip BOOLEAN NOT NULL DEFAULT 0,
    clip_start INTEGER,
    clip_end INTEGER,
    status TEXT DEFAULT 'pending',
    notify_email BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// To avoid errors if the table already exists but without columns,
// we can try to alter the table. better-sqlite3 doesn't have "ADD COLUMN IF NOT EXISTS".
try {
  db.prepare("ALTER TABLE history ADD COLUMN uploaded_url TEXT").run();
} catch (err) {}

try {
  db.prepare("ALTER TABLE history ADD COLUMN duration INTEGER").run();
} catch (err) {}

module.exports = db;
