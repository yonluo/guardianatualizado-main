const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { migrateStoredCameraSecrets } = require('./services/cameraSecurity');

// escolher backend de persistência via env: 'mysql' ou 'sqlite' (default sqlite)
const DB_TYPE = process.env.DB_TYPE || 'sqlite';

let db = null;

async function run(sql, params) {
  if (DB_TYPE === 'mysql') {
    // mysql2 pool
    const [result] = await db.execute(sql, params || []);
    return { lastID: result.insertId, affectedRows: result.affectedRows, result };
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function get(sql, params) {
  if (DB_TYPE === 'mysql') {
    const [rows] = await db.execute(sql, params || []);
    return rows[0] || null;
  }
  return new Promise((resolve, reject) => {
    db.get(sql, params || [], (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function all(sql, params) {
  if (DB_TYPE === 'mysql') {
    const [rows] = await db.execute(sql, params || []);
    return rows;
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function init() {
  if (DB_TYPE === 'mysql') {
    // usar MySQL: criar pool e retornar (assume que schema já exista ou será aplicado via script SQL)
    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'angel_guardian',
      waitForConnections: true,
      connectionLimit: 10,
    });
    db = pool;
    try {
      // test connection
      await pool.query('SELECT 1');
      console.log('DB: usando MySQL', process.env.DB_NAME || 'angel_guardian', '- conexão OK');
    } catch (err) {
      console.error('DB: erro ao conectar MySQL', err.message || err);
      throw err;
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS community_posts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      category VARCHAR(40) NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX community_posts_created_at (created_at)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS community_post_media (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      post_id BIGINT NOT NULL,
      media_type VARCHAR(10) NOT NULL,
      mime_type VARCHAR(80) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      data LONGBLOB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX community_post_media_post_id (post_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS community_stories (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      category VARCHAR(40) NOT NULL,
      content VARCHAR(500) NOT NULL,
      media_type VARCHAR(10) NULL,
      mime_type VARCHAR(80) NULL,
      file_name VARCHAR(255) NULL,
      media_data LONGBLOB NULL,
      is_alert BOOLEAN NOT NULL DEFAULT FALSE,
      encrypted_report_number TEXT NULL,
      report_date DATE NULL,
      report_mime_type VARCHAR(80) NULL,
      report_file_name VARCHAR(255) NULL,
      encrypted_report_evidence LONGTEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at BIGINT NOT NULL,
      INDEX ix_community_stories_expiry (expires_at, created_at),
      INDEX ix_community_stories_user (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS community_post_comments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      post_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      content VARCHAR(1000) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX community_post_comments_post_created (post_id, created_at),
      FOREIGN KEY (post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_settings (
      user_id INT NOT NULL,
      setting_key VARCHAR(64) NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, setting_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contacts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      requester_id INT NOT NULL,
      recipient_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY contacts_pair (requester_id, recipient_id),
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contact_groups (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      owner_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contact_group_members (
      group_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      PRIMARY KEY (group_id, user_id),
      FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(16) NOT NULL,
      group_id BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX conversations_group_id (group_id),
      FOREIGN KEY (group_id) REFERENCES contact_groups(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      conversation_id BIGINT NOT NULL,
      sender_id INT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX messages_conversation_created (conversation_id, created_at),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS message_media (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id BIGINT NOT NULL,
      mime_type VARCHAR(80) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      data LONGBLOB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS managed_cameras (
      id VARCHAR(36) PRIMARY KEY,
      owner_id BIGINT NOT NULL,
      name VARCHAR(80) NOT NULL,
      location VARCHAR(180) NOT NULL,
      latitude DOUBLE NULL,
      longitude DOUBLE NULL,
      encrypted_report_number TEXT NOT NULL,
      report_date DATE NOT NULL,
      encrypted_source TEXT NOT NULL,
      path_name VARCHAR(80) NOT NULL UNIQUE,
      is_public BOOLEAN NOT NULL DEFAULT FALSE,
      release_status VARCHAR(16) NOT NULL DEFAULT 'pending',
      review_by BIGINT NULL,
      reviewed_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX managed_cameras_owner_created (owner_id, created_at)
    )`);
    const [cameraColumns] = await pool.query('SHOW COLUMNS FROM managed_cameras LIKE ?', ['is_public']);
    if (!cameraColumns.length) {
      await pool.query('ALTER TABLE managed_cameras ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE');
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS camera_access_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      camera_id VARCHAR(36) NOT NULL,
      requester_id INT NOT NULL,
      owner_id INT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      decided_at TIMESTAMP NULL,
      UNIQUE KEY camera_access_request_pair (camera_id, requester_id),
      INDEX camera_access_owner_status (owner_id, status),
      FOREIGN KEY (camera_id) REFERENCES managed_cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS camera_report_evidence (
      camera_id VARCHAR(36) PRIMARY KEY,
      mime_type VARCHAR(80) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      encrypted_data LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS site_feedback (
      user_id BIGINT PRIMARY KEY,
      comment VARCHAR(500) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await migrateStoredCameraSecrets({ all, run });
    return;
  }

  // sqlite default
  const sqlite3 = require('sqlite3').verbose();
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'database.sqlite');
  const exists = fs.existsSync(DB_PATH);
  db = new sqlite3.Database(DB_PATH);
  // create tables
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    cpf TEXT,
    telefone TEXT,
    birthdate TEXT,
    avatar_url TEXT,
    bio TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await run(`CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS community_post_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES community_posts(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS community_stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    media_type TEXT,
    mime_type TEXT,
    file_name TEXT,
    media_data BLOB,
    is_alert INTEGER NOT NULL DEFAULT 0,
    encrypted_report_number TEXT,
    report_date TEXT,
    report_mime_type TEXT,
    report_file_name TEXT,
    encrypted_report_evidence TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('CREATE INDEX IF NOT EXISTS community_stories_expiry ON community_stories(expires_at, created_at)');
  await run('CREATE INDEX IF NOT EXISTS community_stories_user ON community_stories(user_id, created_at)');

  await run(`CREATE TABLE IF NOT EXISTS community_post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES community_posts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE INDEX IF NOT EXISTS community_post_comments_post_created
    ON community_post_comments(post_id, created_at)`);
  await run(`CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL,
    setting_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, setting_key),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(requester_id, recipient_id),
    FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(recipient_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS contact_group_members (
    group_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(group_id, user_id),
    FOREIGN KEY(group_id) REFERENCES contact_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    group_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(group_id) REFERENCES contact_groups(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY(conversation_id, user_id),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS message_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS camera_access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    camera_id TEXT NOT NULL,
    requester_id INTEGER NOT NULL,
    owner_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME,
    UNIQUE(camera_id, requester_id),
    FOREIGN KEY(camera_id) REFERENCES managed_cameras(id) ON DELETE CASCADE,
    FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run('CREATE INDEX IF NOT EXISTS camera_access_owner_status ON camera_access_requests(owner_id, status)');
  await run(`CREATE TABLE IF NOT EXISTS managed_cameras (
    id TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    encrypted_report_number TEXT NOT NULL,
    report_date TEXT NOT NULL,
    encrypted_source TEXT NOT NULL,
    path_name TEXT NOT NULL UNIQUE,
    release_status TEXT NOT NULL DEFAULT 'pending',
    review_by INTEGER,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  const cameraColumns = await all('PRAGMA table_info(managed_cameras)');
  if (!cameraColumns.some((column) => column.name === 'is_public')) {
    await run('ALTER TABLE managed_cameras ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  }

  await run(`CREATE TABLE IF NOT EXISTS camera_report_evidence (
    camera_id TEXT PRIMARY KEY,
    mime_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(camera_id) REFERENCES managed_cameras(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS site_feedback (
    user_id INTEGER PRIMARY KEY,
    comment TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS alert_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT,
    icon TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    alert_type_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    is_urgent INTEGER DEFAULT 0,
    latitude REAL,
    longitude REAL,
    address TEXT,
    neighborhood TEXT,
    city TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(alert_type_id) REFERENCES alert_types(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS alert_media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    media_type TEXT DEFAULT 'image',
    media_url TEXT NOT NULL,
    caption TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    alert_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, alert_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS saved_alerts (
    user_id INTEGER NOT NULL,
    alert_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, alert_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    alert_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
  )`);

  // seed alert_types
  const types = [
    ['Assalto', '#E53935', 'alert'],
    ['Furto', '#FBC02D', 'package'],
    ['Suspeito', '#FB8C00', 'user'],
    ['Emergência', '#D32F2F', 'warning'],
  ];
  for (const t of types) {
    await run(`INSERT OR IGNORE INTO alert_types (name,color,icon) VALUES (?,?,?)`, t);
  }

  // seed users (test hashes)
  const pwd = bcrypt.hashSync('senha123', 10);
  await run(
    `INSERT OR IGNORE INTO users (name,email,password_hash,cpf,telefone,avatar_url,bio,birthdate) VALUES (?,?,?,?,?,?,?,?)`,
    [
      'Pedro Lima',
      'pedro@email.com',
      pwd,
      '111.111.111-11',
      '(21) 98888-0000',
      'https://i.pravatar.cc/150?img=12',
      'Guardião local com foco em segurança comunitária.',
      '1990-04-12',
    ]
  );
  await run(
    `INSERT OR IGNORE INTO users (name,email,password_hash,cpf,telefone,avatar_url,bio,birthdate) VALUES (?,?,?,?,?,?,?,?)`,
    [
      'Ana Costa',
      'ana@email.com',
      pwd,
      '222.222.222-22',
      '(21) 97777-0000',
      'https://i.pravatar.cc/150?img=32',
      'Acompanho alertas e apoio a comunidade.',
      '1988-11-08',
    ]
  );

  // seed alerts
  await run(
    `INSERT OR IGNORE INTO alerts (user_id,alert_type_id,title,description,is_urgent,latitude,longitude,address,neighborhood,city) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      1,
      1,
      'Assalto na Praça XV',
      'Furtaram um carro na Praça XV! Foto do suspeito.',
      1,
      -22.9035,
      -43.2096,
      'Praça XV',
      'Centro',
      'Rio de Janeiro',
    ]
  );
  await run(
    `INSERT OR IGNORE INTO alerts (user_id,alert_type_id,title,description,is_urgent,latitude,longitude,address,neighborhood,city) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      2,
      3,
      'Homem suspeito visto novamente',
      'Homem suspeito visto novamente! Tomem cuidado!',
      0,
      -22.904,
      -43.2102,
      'Rua Central',
      'Centro',
      'Rio de Janeiro',
    ]
  );

  // seed comments
  await run(`INSERT OR IGNORE INTO comments (alert_id,user_id,content) VALUES (?,?,?)`, [
    1,
    2,
    'Obrigado por avisar!',
  ]);
  await run(`INSERT OR IGNORE INTO comments (alert_id,user_id,content) VALUES (?,?,?)`, [
    2,
    1,
    'Vi ele também!',
  ]);

  await migrateStoredCameraSecrets({ all, run });
}

const ready = init();
ready.catch((err) => console.error('DB init error', err));

module.exports = { db, run, get, all, ready };
