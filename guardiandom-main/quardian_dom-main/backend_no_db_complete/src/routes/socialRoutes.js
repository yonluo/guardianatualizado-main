const express = require('express');
const { authenticate } = require('../services/auth');
const { all, get, run } = require('../db');
const { createNotification } = require('../services/notifications');

const router = express.Router();
const maxMediaBytes = 4 * 1024 * 1024;
const mediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);
router.use(authenticate);

router.get('/contacts', async (req, res) => {
  try {
    const contacts = await all(
      `SELECT c.id, c.status, c.requester_id AS requesterId, c.recipient_id AS recipientId,
        u.id AS userId, u.name, u.email
       FROM contacts c
       JOIN users u ON u.id = CASE WHEN c.requester_id = ? THEN c.recipient_id ELSE c.requester_id END
       WHERE c.requester_id = ? OR c.recipient_id = ?
       ORDER BY c.created_at DESC`,
      [req.user.id, req.user.id, req.user.id]
    );
    return res.json(contacts.map((contact) => ({
      id: contact.id,
      userId: contact.userId,
      name: contact.name,
      email: contact.email,
      status: contact.status,
      direction: Number(contact.requesterId) === Number(req.user.id) ? 'outgoing' : 'incoming',
    })));
  } catch (error) {
    console.error('contacts list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar os contatos.' });
  }
});

router.post('/contacts', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 150) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  try {
    const user = await get('SELECT id, name, email FROM users WHERE lower(email) = ?', [email]);
    if (!user) return res.status(404).json({ error: 'Não encontramos uma conta com esse e-mail.' });
    if (Number(user.id) === Number(req.user.id)) return res.status(400).json({ error: 'Você não pode adicionar sua própria conta.' });
    const existing = await get(
      `SELECT id, status FROM contacts
       WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)`,
      [req.user.id, user.id, user.id, req.user.id]
    );
    if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Este contato já está conectado.' : 'Já existe um convite entre estas contas.' });
    const created = await run('INSERT INTO contacts (requester_id, recipient_id) VALUES (?, ?)', [req.user.id, user.id]);
    await createNotification(req.app, user.id, 'Convite de contato', `${req.user.name || 'Uma pessoa'} enviou um convite para se conectar no Guardian.`);
    return res.status(201).json({ id: created.lastID, userId: user.id, name: user.name, email: user.email, status: 'pending', direction: 'outgoing' });
  } catch (error) {
    console.error('contact invite failed', error.message);
    return res.status(500).json({ error: 'Não foi possível enviar o convite.' });
  }
});

router.patch('/contacts/:id', async (req, res) => {
  const status = req.body?.status;
  if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Resposta inválida.' });
  try {
    const result = await run('UPDATE contacts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND recipient_id = ? AND status = ?', [status, req.params.id, req.user.id, 'pending']);
    if (!result.affectedRows && !result.changes) return res.status(404).json({ error: 'Convite não encontrado ou já respondido.' });
    const invite = await get('SELECT requester_id AS requesterId, recipient_id AS recipientId FROM contacts WHERE id = ?', [req.params.id]);
    if (status === 'accepted' && invite) {
      const otherUserId = Number(invite.requesterId) === Number(req.user.id) ? Number(invite.recipientId) : Number(invite.requesterId);
      const existing = await get(
        `SELECT mine.conversation_id AS id FROM conversation_members mine
         JOIN conversation_members peer ON peer.conversation_id = mine.conversation_id
         JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'direct'
         WHERE mine.user_id = ? AND peer.user_id = ?`,
        [req.user.id, otherUserId]
      );
      if (!existing) {
        const created = await run("INSERT INTO conversations (type) VALUES ('direct')", []);
        const conversationId = created.lastID;
        await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [conversationId, req.user.id]);
        await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [conversationId, otherUserId]);
      }
      const responder = await get('SELECT name FROM users WHERE id = ?', [req.user.id]);
      await createNotification(req.app, invite.requesterId, 'Convite aceito', `${responder?.name || 'Seu contato'} aceitou seu convite.`);
    }
    return res.json({ mensagem: status === 'accepted' ? 'Convite aceito.' : 'Convite recusado.' });
  } catch (error) {
    console.error('contact response failed', error.message);
    return res.status(500).json({ error: 'Não foi possível responder ao convite.' });
  }
});

router.delete('/contacts/:id', async (req, res) => {
  try {
    const contact = await get(
      'SELECT requester_id AS requesterId, recipient_id AS recipientId FROM contacts WHERE id = ? AND (requester_id = ? OR recipient_id = ?)',
      [req.params.id, req.user.id, req.user.id]
    );
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado.' });
    const directConversations = await all(
      `SELECT mine.conversation_id AS id FROM conversation_members mine
       JOIN conversation_members peer ON peer.conversation_id = mine.conversation_id
       JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'direct'
       WHERE mine.user_id = ? AND peer.user_id = ?`,
      [contact.requesterId, contact.recipientId]
    );
    for (const conversation of directConversations) {
      await run('DELETE FROM message_media WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)', [conversation.id]);
      await run('DELETE FROM messages WHERE conversation_id = ?', [conversation.id]);
      await run('DELETE FROM conversation_members WHERE conversation_id = ?', [conversation.id]);
      await run('DELETE FROM conversations WHERE id = ?', [conversation.id]);
    }
    const result = await run('DELETE FROM contacts WHERE id = ? AND (requester_id = ? OR recipient_id = ?)', [req.params.id, req.user.id, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(404).json({ error: 'Contato não encontrado.' });
    return res.status(204).end();
  } catch (error) {
    console.error('contact removal failed', error.message);
    return res.status(500).json({ error: 'Não foi possível remover o contato.' });
  }
});

router.get('/groups', async (req, res) => {
  try {
    const groups = await all(
      `SELECT DISTINCT g.id, g.name, g.description, g.owner_id AS ownerId, g.created_at AS createdAt
       FROM contact_groups g JOIN contact_group_members m ON m.group_id = g.id
       WHERE m.user_id = ? ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    for (const group of groups) {
      group.members = await all(
        'SELECT u.id, u.name, u.email FROM contact_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?',
        [group.id]
      );
    }
    return res.json(groups);
  } catch (error) {
    console.error('groups list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar os grupos.' });
  }
});

router.post('/groups', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  const members = Array.isArray(req.body?.members) ? [...new Set(req.body.members.map(Number))] : [];
  if (!name || name.length > 100 || description.length > 255) return res.status(400).json({ error: 'Informe nome e descrição válidos.' });
  try {
    const accepted = await all(
      `SELECT CASE WHEN requester_id = ? THEN recipient_id ELSE requester_id END AS userId
       FROM contacts WHERE status = 'accepted' AND (requester_id = ? OR recipient_id = ?)`,
      [req.user.id, req.user.id, req.user.id]
    );
    const allowed = new Set(accepted.map((item) => Number(item.userId)));
    if (members.some((id) => !allowed.has(id))) return res.status(403).json({ error: 'Grupos aceitam somente contatos confirmados.' });
    const group = await run('INSERT INTO contact_groups (owner_id, name, description) VALUES (?, ?, ?)', [req.user.id, name, description]);
    const groupId = group.lastID;
    await run('INSERT INTO contact_group_members (group_id, user_id) VALUES (?, ?)', [groupId, req.user.id]);
    for (const userId of members) await run('INSERT INTO contact_group_members (group_id, user_id) VALUES (?, ?)', [groupId, userId]);
    const conversation = await run("INSERT INTO conversations (type, group_id) VALUES ('group', ?)", [groupId]);
    const allMembers = [req.user.id, ...members];
    for (const userId of allMembers) await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [conversation.lastID, userId]);
    return res.status(201).json({ id: groupId, name, description, ownerId: req.user.id, members: allMembers, conversationId: conversation.lastID });
  } catch (error) {
    console.error('group creation failed', error.message);
    return res.status(500).json({ error: 'Não foi possível criar o grupo.' });
  }
});

router.delete('/groups/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM contact_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id]);
    if (!result.affectedRows && !result.changes) return res.status(404).json({ error: 'Grupo não encontrado.' });
    return res.status(204).end();
  } catch (error) {
    console.error('group removal failed', error.message);
    return res.status(500).json({ error: 'Não foi possível excluir o grupo.' });
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await all(
      `SELECT DISTINCT c.id, c.type, c.group_id AS groupId, g.name AS groupName,
        CASE WHEN c.type = 'direct' THEN other.id ELSE NULL END AS otherUserId,
        CASE WHEN c.type = 'direct' THEN other.name ELSE g.name END AS name,
        CASE WHEN c.type = 'direct' THEN other.email ELSE NULL END AS email
       FROM conversation_members mine JOIN conversations c ON c.id = mine.conversation_id
       LEFT JOIN contact_groups g ON g.id = c.group_id
       LEFT JOIN conversation_members peer ON peer.conversation_id = c.id AND peer.user_id <> ?
       LEFT JOIN users other ON other.id = peer.user_id
       WHERE mine.user_id = ? ORDER BY c.id DESC`,
      [req.user.id, req.user.id]
    );
    for (const conversation of conversations) {
      const message = await get('SELECT content, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversation.id]);
      conversation.messages = message ? [{ text: message.content, time: message.createdAt }] : [];
    }
    return res.json(conversations);
  } catch (error) {
    console.error('conversations list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as conversas.' });
  }
});

router.post('/conversations/direct', async (req, res) => {
  const otherUserId = Number(req.body?.userId);
  if (!Number.isInteger(otherUserId) || otherUserId === Number(req.user.id)) return res.status(400).json({ error: 'Contato inválido.' });
  try {
    const relation = await get(
      `SELECT id FROM contacts WHERE status = 'accepted' AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
      [req.user.id, otherUserId, otherUserId, req.user.id]
    );
    if (!relation) return res.status(403).json({ error: 'Só é possível conversar com contatos confirmados.' });
    const target = await get('SELECT id FROM users WHERE id = ?', [otherUserId]);
    if (!target) return res.status(404).json({ error: 'Contato não encontrado.' });
    const existing = await all(
      `SELECT mine.conversation_id AS id FROM conversation_members mine
       JOIN conversation_members peer ON peer.conversation_id = mine.conversation_id
       JOIN conversations c ON c.id = mine.conversation_id AND c.type = 'direct'
       WHERE mine.user_id = ? AND peer.user_id = ?`,
      [req.user.id, otherUserId]
    );
    let conversationId = existing[0]?.id;
    if (!conversationId) {
      const created = await run("INSERT INTO conversations (type) VALUES ('direct')", []);
      conversationId = created.lastID;
      await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [conversationId, req.user.id]);
      await run('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)', [conversationId, otherUserId]);
    }
    return res.json({ id: conversationId });
  } catch (error) {
    console.error('direct conversation creation failed', error.message);
    return res.status(500).json({ error: 'Não foi possível abrir a conversa.' });
  }
});

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!member) return res.status(404).json({ error: 'Conversa não encontrada.' });
    const afterId = Number(req.query.after);
    const hasAfterId = Number.isSafeInteger(afterId) && afterId > 0;
    const messages = await all(
      `SELECT m.id, m.sender_id AS senderId, u.name AS author, m.content AS text,
        m.created_at AS createdAt FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = ? ${hasAfterId ? 'AND m.id > ?' : ''}
       ORDER BY m.id ASC LIMIT 500`,
      hasAfterId ? [req.params.id, afterId] : [req.params.id]
    );
    for (const message of messages) {
      message.media = await all(
        'SELECT id, message_id AS messageId, mime_type AS mimeType, file_name AS fileName FROM message_media WHERE message_id = ?',
        [message.id]
      );
      message.media = message.media.map((item) => ({
        ...item,
        name: item.fileName,
        type: item.mimeType,
      }));
    }
    return res.json(messages);
  } catch (error) {
    console.error('message list failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar as mensagens.' });
  }
});

router.post('/conversations/:id/messages', async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const media = req.body?.media;
  if (content.length > 4000) return res.status(400).json({ error: 'A mensagem excede 4.000 caracteres.' });
  if (!content && !media) return res.status(400).json({ error: 'Escreva uma mensagem ou anexe uma mídia.' });
  try {
    const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!member) return res.status(404).json({ error: 'Conversa não encontrada.' });
    let data;
    if (media) {
      if (!mediaTypes.has(media.mimeType) || typeof media.data !== 'string' || typeof media.fileName !== 'string') return res.status(400).json({ error: 'Formato de mídia não permitido.' });
      data = Buffer.from(media.data, 'base64');
      if (!data.length || data.length > maxMediaBytes || data.toString('base64') !== media.data) return res.status(400).json({ error: 'A mídia deve ter até 4 MB e estar válida.' });
    }
    const created = await run('INSERT INTO messages (conversation_id, sender_id, content) VALUES (?, ?, ?)', [req.params.id, req.user.id, content]);
    let finalMedia = [];
    if (media) {
      const mediaInsert = await run('INSERT INTO message_media (message_id, mime_type, file_name, data) VALUES (?, ?, ?, ?)', [created.lastID, media.mimeType, String(media.fileName).replace(/[\r\n"]/g, '').slice(0, 255), data]);
      finalMedia = [{ id: mediaInsert.lastID, mimeType: media.mimeType, fileName: media.fileName, type: media.mimeType, name: media.fileName }];
    }
    const peers = await all('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?', [req.params.id, req.user.id]);
    const sender = await get('SELECT name FROM users WHERE id = ?', [req.user.id]);
    const messagePayload = {
      id: created.lastID,
      senderId: req.user.id,
      author: sender?.name || 'Você',
      text: content,
      createdAt: new Date().toISOString(),
      media: finalMedia,
    };
    for (const peer of peers) {
      await createNotification(req.app, peer.user_id, 'Nova mensagem', `${sender?.name || 'Um contato'} enviou uma mensagem.`);
      const io = req.app.get('io');
      io?.to(String(peer.user_id)).emit('message:received', {
        conversationId: Number(req.params.id),
        senderId: req.user.id,
        senderName: sender?.name || 'Você',
        message: messagePayload,
      });
    }
    const io = req.app.get('io');
    io?.to(String(req.user.id)).emit('message:received', {
      conversationId: Number(req.params.id),
      senderId: req.user.id,
      senderName: sender?.name || 'Você',
      message: messagePayload,
    });
    return res.status(201).json({ id: created.lastID, senderId: req.user.id, text: content, createdAt: new Date().toISOString(), media: finalMedia });
  } catch (error) {
    console.error('message save failed', error.message);
    return res.status(500).json({ error: 'Não foi possível enviar a mensagem.' });
  }
});

router.get('/messages/:messageId/media/:mediaId', async (req, res) => {
  try {
    const media = await get(
      `SELECT mm.mime_type AS mimeType, mm.file_name AS fileName, mm.data
       FROM message_media mm JOIN messages m ON m.id = mm.message_id
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
       WHERE m.id = ? AND mm.id = ? AND cm.user_id = ?`,
      [req.params.messageId, req.params.mediaId, req.user.id]
    );
    if (!media) return res.status(404).json({ error: 'Mídia não encontrada.' });
    res.set({ 'Content-Type': media.mimeType, 'Content-Length': media.data.length, 'Content-Disposition': `inline; filename="${media.fileName.replace(/[\r\n"]/g, '')}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.send(media.data);
  } catch (error) {
    console.error('message media lookup failed', error.message);
    return res.status(500).json({ error: 'Não foi possível carregar a mídia.' });
  }
});

module.exports = router;
