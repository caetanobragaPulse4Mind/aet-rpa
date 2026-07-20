const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireBearerToken } = require('../middleware/auth');

const router = express.Router();
const PDF_BASE_DIR = '/app/pdfs/aets';

// GET /aet-especifica/:numero/:ano
router.get('/:numero/:ano', requireBearerToken, async (req, res) => {
  try {
    const { numero, ano } = req.params;

    // validação — só dígitos, evita path traversal
    if (!/^\d+$/.test(numero) || !/^\d{4}$/.test(ano)) {
      return res.status(400).json({ erro: 'Parâmetros "numero" e "ano" devem ser numéricos' });
    }

    const filePath = path.join(PDF_BASE_DIR, `${numero}-${ano}.pdf`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ erro: 'PDF não encontrado no volume. Pode ainda não ter sido processado pelo anexar_aets.js.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${numero}-${ano}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=300');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamErr) => {
      console.error('Erro ao ler PDF:', streamErr);
      if (!res.headersSent) res.status(500).json({ erro: 'Falha ao ler o arquivo PDF' });
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Erro em /aet-especifica:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;