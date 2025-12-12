/**
 * Serveur Express principal pour la traduction CSV via DeepSeek
 * Gère l'upload de fichiers, la traduction parallélisée et les SSE
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');

const translateRoutes = require('./routes/translate');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares de sécurité et performance
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(compression()); // Compression gzip
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Fichiers statiques (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Routes API
app.use('/api/translate', translateRoutes);

// Route de santé pour Render
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage()
  });
});

// Gestion des erreurs globale
app.use((err, req, res, next) => {
  console.error('[Erreur]', err.stack);
  res.status(500).json({ 
    error: 'Erreur serveur interne',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Démarrage du serveur - écoute sur 0.0.0.0 pour Render
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Serveur] Démarré sur le port ${PORT}`);
  console.log(`[Serveur] API Key: ${process.env.DEEPSEEK_API_KEY ? 'Configurée' : 'MANQUANTE'}`);
});

// Gestion propre de l'arrêt
process.on('SIGTERM', () => {
  console.log('[Serveur] Arrêt gracieux...');
  process.exit(0);
});

module.exports = app;
