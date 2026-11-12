const express = require('express');
const router = express.Router();
const { authenticate } = require('../services/auth');
const { all, run } = require('../db');

const knownSettings = new Set([
  'profileVisible',
  'notifications',
  'privacyMode',
  'cameraSharing',
  'emergencyAlerts',
]);
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT setting_key AS name, enabled FROM user_settings WHERE user_id = ?', [req.user.id]);
    return res.json(Object.fromEntries(rows.map((row) => [row.name, Boolean(row.enabled)])));
  } catch (error) {
    console.error('settings lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as configurações.' });
  }
});

router.put('/', async (req, res) => {
  const settings = req.body?.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ error: 'Envie as configurações como objeto.' });
  }
  try {
    for (const [name, enabled] of Object.entries(settings)) {
      if (!knownSettings.has(name) || typeof enabled !== 'boolean') continue;
      const current = await getSetting(req.user.id, name);
      if (current) {
        await run('UPDATE user_settings SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND setting_key = ?', [Number(enabled), req.user.id, name]);
      } else {
        await run('INSERT INTO user_settings (user_id, setting_key, enabled) VALUES (?, ?, ?)', [req.user.id, name, Number(enabled)]);
      }
    }
    return res.json({ mensagem: 'Configurações atualizadas.' });
  } catch (error) {
    console.error('settings update failed', error.message);
    return res.status(500).json({ error: 'Não foi possível salvar as configurações.' });
  }
});

async function getSetting(userId, name) {
  const rows = await all('SELECT user_id FROM user_settings WHERE user_id = ? AND setting_key = ?', [userId, name]);
  return rows.length > 0;
}

module.exports = router;
