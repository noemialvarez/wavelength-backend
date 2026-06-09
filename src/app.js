require('dotenv').config();
const express = require('express');
const cors = require('cors');

const leadsRouter = require('./routes/leads');
const discoveryRouter = require('./routes/discovery');
const outreachRouter = require('./routes/outreach');
const engagementRouter = require('./routes/engagement');
const sequencesRouter = require('./routes/sequences');

const app = express();

app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  credentials: true,
}));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/leads', leadsRouter);
app.use('/api/discovery', discoveryRouter);
app.use('/api/outreach', outreachRouter);
app.use('/api/engagement', engagementRouter);
app.use('/api/sequences', sequencesRouter);

app.use((err, req, res, _next) => {
  console.error(`\n[UNHANDLED ERROR] ${req.method} ${req.originalUrl}`);
  console.error('  message:', err.message);
  console.error('  stack:\n', err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
