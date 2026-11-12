require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

const database = process.env.DB_NAME || 'angel_guardian';
if (!/^[A-Za-z0-9_]+$/.test(database)) {
  throw new Error('DB_NAME may contain only letters, numbers, and underscores.');
}

const tables = [
  'users', 'alert_types', 'alerts', 'alert_media', 'comments', 'likes', 'shares',
  'saved_alerts', 'notifications', 'reports', 'community_posts', 'community_post_media', 'community_stories',
  'community_post_comments', 'user_settings', 'contacts', 'contact_groups',
  'contact_group_members', 'conversations', 'conversation_members', 'messages',
  'message_media', 'managed_cameras', 'camera_report_evidence', 'camera_access_requests',
  'site_feedback', 'schema_migrations',
];
const identifier = (value) => `\`${value}\``;

async function tableExists(connection, table) {
  const [rows] = await connection.execute(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return rows.length > 0;
}

async function getColumn(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_TYPE AS columnType FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return rows[0] || null;
}

async function ensureColumn(connection, table, column, definition) {
  if (!(await tableExists(connection, table))) return;
  if (!(await getColumn(connection, table, column))) {
    await connection.query(`ALTER TABLE ${identifier(table)} ADD COLUMN ${identifier(column)} ${definition}`);
  }
}

async function hasUniqueIndex(connection, table, columns) {
  const [indexes] = await connection.execute(
    `SELECT INDEX_NAME AS indexName, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS indexedColumns
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND NON_UNIQUE = 0
     GROUP BY INDEX_NAME`,
    [table]
  );
  const expected = columns.join(',');
  return indexes.some((index) => index.indexedColumns === expected);
}

async function ensureUniqueIndex(connection, table, name, columns) {
  if (!(await hasUniqueIndex(connection, table, columns))) {
    await connection.query(
      `ALTER TABLE ${identifier(table)} ADD UNIQUE KEY ${identifier(name)} (${columns.map(identifier).join(', ')})`
    );
  }
}

async function ensureForeignKey(connection, { table, column, parent, parentColumn = 'id', name, onDelete = 'CASCADE' }) {
  const [existing] = await connection.execute(
        `SELECT k.CONSTRAINT_NAME AS constraintName, r.DELETE_RULE AS deleteRule,
          r.UPDATE_RULE AS updateRule
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     WHERE k.table_schema = DATABASE() AND k.table_name = ? AND k.column_name = ?
       AND k.referenced_table_name = ? AND k.referenced_column_name = ?`,
    [table, column, parent, parentColumn]
  );
  const [orphans] = await connection.query(
    `SELECT COUNT(*) AS count FROM ${identifier(table)} child
     LEFT JOIN ${identifier(parent)} parent ON child.${identifier(column)} = parent.${identifier(parentColumn)}
     WHERE child.${identifier(column)} IS NOT NULL AND parent.${identifier(parentColumn)} IS NULL`
  );
  if (Number(orphans[0].count) > 0) {
    throw new Error(`Migration blocked: ${table}.${column} has ${orphans[0].count} orphan row(s); repair or back up data before adding its foreign key.`);
  }

  if (existing.length && existing[0].deleteRule.toUpperCase() === onDelete.toUpperCase()) return;
  if (existing.length) {
    await connection.query(
      `ALTER TABLE ${identifier(table)} DROP FOREIGN KEY ${identifier(existing[0].constraintName)}`
    );
  }

  try {
    await connection.query(
      `ALTER TABLE ${identifier(table)} ADD CONSTRAINT ${identifier(name)}
       FOREIGN KEY (${identifier(column)}) REFERENCES ${identifier(parent)} (${identifier(parentColumn)}) ON DELETE ${onDelete}`
    );
  } catch (error) {
    if (existing.length) {
      try {
        const oldDeleteRule = existing[0].deleteRule.toUpperCase();
        const oldUpdateRule = existing[0].updateRule.toUpperCase();
        await connection.query(
          `ALTER TABLE ${identifier(table)} ADD CONSTRAINT ${identifier(existing[0].constraintName)}
           FOREIGN KEY (${identifier(column)}) REFERENCES ${identifier(parent)} (${identifier(parentColumn)})
           ON DELETE ${oldDeleteRule} ON UPDATE ${oldUpdateRule}`
        );
      } catch (restoreError) {
        throw new Error(`Could not add ${name} or restore ${existing[0].constraintName}: ${restoreError.message}`);
      }
    }
    throw error;
  }
}

async function ensureInnoDb(connection, table) {
  const [rows] = await connection.execute(
    `SELECT ENGINE AS engine FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  if (!rows.length) throw new Error(`Required table ${table} was not created.`);
  if (rows[0].engine !== 'InnoDB') {
    await connection.query(`ALTER TABLE ${identifier(table)} ENGINE=InnoDB`);
  }
}

async function mergeDuplicateAlertTypes(connection) {
  const [duplicates] = await connection.query(
    `SELECT MIN(id) AS keepId, MIN(name) AS name FROM alert_types
     GROUP BY LOWER(TRIM(name)) HAVING COUNT(*) > 1`
  );
  await connection.beginTransaction();
  try {
    for (const duplicate of duplicates) {
      const [rows] = await connection.execute(
        'SELECT id FROM alert_types WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id',
        [duplicate.name]
      );
      const obsoleteIds = rows.map((row) => row.id).filter((id) => Number(id) !== Number(duplicate.keepId));
      if (!obsoleteIds.length) continue;
      const placeholders = obsoleteIds.map(() => '?').join(',');
      await connection.execute(
        `UPDATE alerts SET alert_type_id = ? WHERE alert_type_id IN (${placeholders})`,
        [duplicate.keepId, ...obsoleteIds]
      );
      await connection.execute(`DELETE FROM alert_types WHERE id IN (${placeholders})`, obsoleteIds);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

async function fitUserIdColumn(connection, table, column, nullable) {
  const info = await getColumn(connection, table, column);
  if (!info || /^int(?:\(|$)/i.test(info.columnType)) return;
  const [[range]] = await connection.query(
    `SELECT MIN(${identifier(column)}) AS minimum, MAX(${identifier(column)}) AS maximum FROM ${identifier(table)}`
  );
  if (Number(range.minimum || 0) < -2147483648 || Number(range.maximum || 0) > 2147483647) {
    throw new Error(`Migration blocked: ${table}.${column} contains values outside signed INT range.`);
  }
  await connection.query(
    `ALTER TABLE ${identifier(table)} MODIFY COLUMN ${identifier(column)} INT ${nullable ? 'NULL' : 'NOT NULL'}`
  );
}

async function ensureCanonicalContacts(connection) {
  const [duplicates] = await connection.query(
    `SELECT LEAST(requester_id, recipient_id) AS userLow,
            GREATEST(requester_id, recipient_id) AS userHigh, COUNT(*) AS count
     FROM contacts GROUP BY userLow, userHigh HAVING COUNT(*) > 1 LIMIT 1`
  );
  if (duplicates.length) {
    throw new Error('Migration blocked: duplicate contact pairs exist in either direction. Review them before adding canonical pair uniqueness.');
  }
  const [indexes] = await connection.execute(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'contacts'
       AND index_name = 'uq_contacts_pair_canonical' LIMIT 1`
  );
  if (!indexes.length) {
    await connection.query(
      `CREATE UNIQUE INDEX uq_contacts_pair_canonical ON contacts
       ((LEAST(requester_id, recipient_id)), (GREATEST(requester_id, recipient_id)))`
    );
  }
}

async function ensureUniqueGroupConversations(connection) {
  const [duplicates] = await connection.query(
    `SELECT group_id FROM conversations WHERE group_id IS NOT NULL GROUP BY group_id HAVING COUNT(*) > 1 LIMIT 1`
  );
  if (duplicates.length) {
    throw new Error('Migration blocked: a group has multiple conversations. Review them before adding one-conversation-per-group uniqueness.');
  }
  await ensureUniqueIndex(connection, 'conversations', 'uq_conversations_group', ['group_id']);
}

async function main() {
  const sqlPath = path.join(__dirname, '..', 'sql', 'angel_guardian_init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8').replaceAll('angel_guardian', database);
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    multipleStatements: true,
  });

  try {
    const schemaStatements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const [index, statement] of schemaStatements.entries()) {
      try {
        await connection.query(statement);
      } catch (error) {
        const summary = statement.replace(/\s+/g, ' ').slice(0, 180);
        let mysqlDetails = '';
        try {
          const [warnings] = await connection.query('SHOW WARNINGS');
          mysqlDetails = warnings.map((warning) => `${warning.Code}: ${warning.Message}`).join(' | ');
        } catch {}
        throw new Error(
          `Schema statement ${index + 1}/${schemaStatements.length} failed [${summary}]: ${mysqlDetails || error.message}`
        );
      }
    }
    await ensureColumn(connection, 'users', 'cpf', 'VARCHAR(30) NULL');
    await ensureColumn(connection, 'users', 'telefone', 'VARCHAR(40) NULL');
    await ensureColumn(connection, 'users', 'birthdate', 'DATE NULL');
    await ensureColumn(connection, 'users', 'avatar_url', 'VARCHAR(255) NULL');
    await ensureColumn(connection, 'users', 'bio', 'VARCHAR(255) NULL');
    await ensureColumn(connection, 'users', 'created_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    await ensureColumn(connection, 'users', 'updated_at', 'TIMESTAMP NULL DEFAULT NULL');
    await ensureColumn(connection, 'managed_cameras', 'is_public', 'BOOLEAN NOT NULL DEFAULT FALSE');

    const requiredUserColumns = ['id', 'name', 'email', 'password_hash'];
    for (const column of requiredUserColumns) {
      if (!(await getColumn(connection, 'users', column))) {
        throw new Error(`Migration blocked: users.${column} is required and cannot be synthesized safely.`);
      }
    }
    const [[longEmail]] = await connection.query('SELECT COUNT(*) AS count FROM users WHERE CHAR_LENGTH(email) > 150');
    if (Number(longEmail.count) > 0) {
      throw new Error('Migration blocked: at least one users.email exceeds 150 characters. Review before changing the column collation/length.');
    }
    const [emailDuplicates] = await connection.query(
      `SELECT LOWER(TRIM(email)) AS normalizedEmail FROM users
       GROUP BY normalizedEmail HAVING COUNT(*) > 1 LIMIT 1`
    );
    if (emailDuplicates.length) {
      throw new Error('Migration blocked: duplicate user emails ignoring case/whitespace must be reviewed before enforcing email uniqueness.');
    }
    await connection.query(
      'ALTER TABLE users MODIFY COLUMN email VARCHAR(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL'
    );

    const [[longCategory]] = await connection.query('SELECT COUNT(*) AS count FROM alert_types WHERE CHAR_LENGTH(name) > 50');
    if (Number(longCategory.count) > 0) {
      throw new Error('Migration blocked: at least one alert_types.name exceeds 50 characters. Review before changing its collation/length.');
    }
    for (const table of tables) await ensureInnoDb(connection, table);

    await mergeDuplicateAlertTypes(connection);
    await connection.query(
      'ALTER TABLE alert_types MODIFY COLUMN name VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL'
    );
    await ensureUniqueIndex(connection, 'alert_types', 'uq_alert_types_name', ['name']);
    await ensureUniqueIndex(connection, 'users', 'uq_users_email', ['email']);

    await fitUserIdColumn(connection, 'managed_cameras', 'owner_id', false);
    await fitUserIdColumn(connection, 'managed_cameras', 'review_by', true);
    await fitUserIdColumn(connection, 'site_feedback', 'user_id', false);
    await ensureCanonicalContacts(connection);
    await ensureUniqueGroupConversations(connection);

    const foreignKeys = [
      ['alerts', 'user_id', 'users', 'fk_alerts_user', 'CASCADE'],
      ['alerts', 'alert_type_id', 'alert_types', 'fk_alerts_type', 'RESTRICT'],
      ['alert_media', 'alert_id', 'alerts', 'fk_alert_media_alert', 'CASCADE'],
      ['comments', 'alert_id', 'alerts', 'fk_comments_alert', 'CASCADE'],
      ['comments', 'user_id', 'users', 'fk_comments_user', 'CASCADE'],
      ['likes', 'user_id', 'users', 'fk_likes_user', 'CASCADE'],
      ['likes', 'alert_id', 'alerts', 'fk_likes_alert', 'CASCADE'],
      ['shares', 'alert_id', 'alerts', 'fk_shares_alert', 'CASCADE'],
      ['shares', 'user_id', 'users', 'fk_shares_user', 'CASCADE'],
      ['saved_alerts', 'user_id', 'users', 'fk_saved_alerts_user', 'CASCADE'],
      ['saved_alerts', 'alert_id', 'alerts', 'fk_saved_alerts_alert', 'CASCADE'],
      ['notifications', 'user_id', 'users', 'fk_notifications_user', 'CASCADE'],
      ['reports', 'user_id', 'users', 'fk_reports_user', 'CASCADE'],
      ['reports', 'alert_id', 'alerts', 'fk_reports_alert', 'CASCADE'],
      ['community_posts', 'user_id', 'users', 'fk_community_posts_user', 'CASCADE'],
      ['community_stories', 'user_id', 'users', 'fk_community_stories_user', 'CASCADE'],
      ['community_post_media', 'post_id', 'community_posts', 'fk_community_post_media_post', 'CASCADE'],
      ['community_post_comments', 'post_id', 'community_posts', 'fk_community_post_comments_post', 'CASCADE'],
      ['community_post_comments', 'user_id', 'users', 'fk_community_post_comments_user', 'CASCADE'],
      ['user_settings', 'user_id', 'users', 'fk_user_settings_user', 'CASCADE'],
      ['contacts', 'requester_id', 'users', 'fk_contacts_requester', 'CASCADE'],
      ['contacts', 'recipient_id', 'users', 'fk_contacts_recipient', 'CASCADE'],
      ['contact_groups', 'owner_id', 'users', 'fk_contact_groups_owner', 'CASCADE'],
      ['contact_group_members', 'group_id', 'contact_groups', 'fk_contact_group_members_group', 'CASCADE'],
      ['contact_group_members', 'user_id', 'users', 'fk_contact_group_members_user', 'CASCADE'],
      ['conversations', 'group_id', 'contact_groups', 'fk_conversations_group', 'CASCADE'],
      ['conversation_members', 'conversation_id', 'conversations', 'fk_conversation_members_conversation', 'CASCADE'],
      ['conversation_members', 'user_id', 'users', 'fk_conversation_members_user', 'CASCADE'],
      ['messages', 'conversation_id', 'conversations', 'fk_messages_conversation', 'CASCADE'],
      ['messages', 'sender_id', 'users', 'fk_messages_sender', 'CASCADE'],
      ['message_media', 'message_id', 'messages', 'fk_message_media_message', 'CASCADE'],
      ['managed_cameras', 'owner_id', 'users', 'fk_managed_cameras_owner', 'CASCADE'],
      ['managed_cameras', 'review_by', 'users', 'fk_managed_cameras_reviewer', 'SET NULL'],
      ['camera_report_evidence', 'camera_id', 'managed_cameras', 'fk_camera_report_evidence_camera', 'CASCADE'],
      ['camera_access_requests', 'camera_id', 'managed_cameras', 'fk_camera_access_camera', 'CASCADE'],
      ['camera_access_requests', 'requester_id', 'users', 'fk_camera_access_requester', 'CASCADE'],
      ['camera_access_requests', 'owner_id', 'users', 'fk_camera_access_owner', 'CASCADE'],
      ['site_feedback', 'user_id', 'users', 'fk_site_feedback_user', 'CASCADE'],
    ];
    for (const [table, column, parent, name, onDelete] of foreignKeys) {
      await ensureForeignKey(connection, { table, column, parent, name, onDelete });
    }

    await connection.execute(
      `INSERT INTO schema_migrations (version) VALUES (?) ON DUPLICATE KEY UPDATE version = VALUES(version)`,
      ['003_community_stories']
    );
    const [[migration]] = await connection.query(
      'SELECT version, applied_at AS appliedAt FROM schema_migrations ORDER BY applied_at DESC LIMIT 1'
    );
    console.log(`MySQL migration applied: ${migration.version} at ${migration.appliedAt}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error('MySQL migration failed:', error.message);
  process.exitCode = 1;
});
