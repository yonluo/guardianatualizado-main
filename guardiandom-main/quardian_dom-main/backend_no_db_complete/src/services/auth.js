const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'segredo';

function getToken(req) {
  const authorization = req.headers.authorization || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('token='));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice('token='.length));
  } catch {
    return null;
  }
}

function authenticate(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Autenticação necessária.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.id) return res.status(401).json({ error: 'Token inválido.' });
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

module.exports = { authenticate, getToken };