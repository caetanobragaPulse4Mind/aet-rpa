function requireBearerToken(req, res, next) {
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.AET_RPA_API_TOKEN}`;

  if (!auth || auth !== expected) {
    return res.status(401).json({ erro: 'unauthorized' });
  }
  next();
}

module.exports = { requireBearerToken };