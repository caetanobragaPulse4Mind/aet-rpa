require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

app.use('/aet-especifica', require('./endpoints/aet-especifica'));
// app.use('/solicitar-aet', require('./endpoints/solicitar-aet'));

app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ erro: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`aet-rpa rodando na porta ${PORT}`));