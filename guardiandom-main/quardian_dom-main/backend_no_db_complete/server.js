require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
  },
});
app.set('io', io);

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.headers.origin) return next();
  try {
    const origin = new URL(req.headers.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.get('host')) {
      return res.status(403).json({ error: 'Origem não autorizada.' });
    }
    return next();
  } catch {
    return res.status(403).json({ error: 'Origem não autorizada.' });
  }
});

const path = require('path');
const jwt = require('jsonwebtoken');
const { validateEncryptionKey } = require('./src/services/cameraSecurity');
const { authenticate, getToken } = require('./src/services/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'segredo';
validateEncryptionKey();
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET ||
    process.env.JWT_SECRET.length < 32 ||
    process.env.JWT_SECRET === 'segredo')
) {
  throw new Error('Production requires a strong JWT_SECRET of at least 32 characters.');
}

function getTokenFromReq(req) {
  // check Authorization header
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  // check cookie header
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  const match = cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('token='));
  if (!match) return null;
  return match.split('=')[1];
}

function ensureAuth(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.redirect('/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.redirect('/login');
  }
}

// Rota raiz: servir a SPA apenas para usuários autenticados
app.get('/', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Servir arquivos estáticos do front-end (pasta /public)
// Desabilitar cache para assets e páginas principais durante desenvolvimento
app.use((req, res, next) => {
  try {
    const p = req.path || '';
    if (
      p.startsWith('/assets') ||
      p === '/' ||
      p === '/criar-conta' ||
      p === '/login' ||
      p.endsWith('.js') ||
      p.endsWith('.css') ||
      p.endsWith('.html')
    ) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  } catch (e) {
    // não bloquear em caso de erro no middleware
  }
  next();
});

app.get('/vendor/hls.min.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), (error) => {
    if (error && !res.headersSent) {
      res.status(503).json({ error: 'O player HLS do navegador ainda não foi instalado.' });
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/cameras', require('./src/routes/cameraRoutes'));
app.use('/api/reputation', require('./src/routes/reputationRoutes'));
app.use('/api/requests', require('./src/routes/requestRoutes'));
app.use('/api/notifications', require('./src/routes/notificationRoutes'));
app.use('/api/profile', require('./src/routes/profileRoutes'));
app.use('/api/settings', require('./src/routes/settingsRoutes'));
app.use('/api/feed', require('./src/routes/feedRoutes'));
app.use('/api/stories', require('./src/routes/storyRoutes'));
app.use('/api/social', require('./src/routes/socialRoutes'));
app.use('/api/stories', require('./src/routes/storyRoutes'));

// rota criar conta -> servir SPA (cliente exibirá a tela de criar conta)
app.get('/criar-conta', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// rota de login público
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/auth/session', authenticate, async (req, res) => {
  const { get } = require('./src/db');
  const user = await get(
    'SELECT id, name, email, cpf, telefone, bio FROM users WHERE id = ?',
    [req.user.id]
  );
  if (!user) return res.status(401).json({ error: 'Sessão inválida.' });
  return res.json({ usuario: user });
});

// Rota catch-all: servir SPA para rotas autenticadas
app.get('*', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.use((socket, next) => {
  const token = getToken({ headers: socket.handshake.headers });
  if (!token) return next(new Error('Autenticação necessária.'));
  try {
    socket.data.user = require('jsonwebtoken').verify(token, JWT_SECRET);
    return next();
  } catch {
    return next(new Error('Sessão inválida.'));
  }
});

io.on('connection', (socket) => {
  const userId = String(socket.data.user.id);
  socket.join(userId);
  console.log('Cliente conectado');

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

const PORT = process.env.PORT || 4000;

require('./src/db')
  .ready.then(() => {
    server.listen(PORT, () => {
      console.log(`Rodando ${PORT}`);
    });
  })
  .catch((error) => {
    console.error(
      'Server startup failed; database or camera-secret migration could not complete:',
      error.message
    );
    process.exitCode = 1;
  });
