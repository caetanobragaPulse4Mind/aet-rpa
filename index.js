require('dotenv').config();

const express = require('express');
const app = express();

app.use(express.json());

// ── Health check ──────────────────────────────────────────
// Usado pelo HEALTHCHECK do Dockerfile e para validar o deploy no Portainer/Traefik
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Rotas de negócio (placeholders) ───────────────────────
// Substituir pelos módulos reais assim que existirem:
// const { solicitarAET } = require('./solicitar_aet');
// const { imprimirAET } = require('./imprimir_aet');

app.post('/solicitar-aet', async (req, res) => {
  try {
    // TODO: integrar com solicitar_aet.js
    res.status(501).json({ erro: 'Endpoint ainda não implementado' });
  } catch (err) {
    console.error('Erro em /solicitar-aet:', err);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/imprimir-aet', async (req, res) => {
  try {
    // TODO: integrar com imprimir_aet.js (retorna PDF via page.pdf())
    res.status(501).json({ erro: 'Endpoint ainda não implementado' });
  } catch (err) {
    console.error('Erro em /imprimir-aet:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ── Tratamento de erro genérico ───────────────────────────
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

// ── Inicialização ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`aet-rpa rodando na porta ${PORT}`);
});