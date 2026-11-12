const { run } = require('../db');

async function createNotification(app, userId, title, message) {
  const created = await run(
    'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
    [userId, title, message]
  );
  const notification = {
    id: created.lastID,
    title,
    message,
    isRead: false,
    createdAt: new Date().toISOString(),
  };
  app.get('io')?.to(String(userId)).emit('notification:new', notification);
  return notification;
}

module.exports = { createNotification };
