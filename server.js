require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Postgres setup ---
const pgPool = new Pool({
  connectionString: process.env.POSTGRES_URL, // e.g. postgresql://user:pass@localhost:5432/guestbook
});

// --- MongoDB setup ---
const mongoClient = new MongoClient(process.env.MONGO_URL); // e.g. mongodb://localhost:27017
let messagesCollection;

async function initMongo() {
  await mongoClient.connect();
  const db = mongoClient.db('guestbook');
  messagesCollection = db.collection('messages');
  console.log('Connected to MongoDB');
}

async function initPostgres() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS signers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Postgres ready');
}

// --- Routes ---

// Sign the guestbook: writes to BOTH databases
app.post('/api/sign', async (req, res) => {
  const { name, message, mood } = req.body;

  if (!name || !message) {
    return res.status(400).json({ error: 'name and message are required' });
  }

  try {
    // 1. Insert structured signer record into Postgres
    const pgResult = await pgPool.query(
      'INSERT INTO signers (name) VALUES ($1) RETURNING id, created_at',
      [name]
    );
    const signerId = pgResult.rows[0].id;

    // 2. Insert free-form message document into MongoDB
    await messagesCollection.insertOne({
      signer_id: signerId,
      message,
      mood: mood || null,
      created_at: new Date(),
    });

    res.status(201).json({ success: true, signer_id: signerId });
  } catch (err) {
    console.error('Error signing guestbook:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Read the guestbook: reads from BOTH databases and merges
app.get('/api/entries', async (req, res) => {
  try {
    const { rows: signers } = await pgPool.query(
      'SELECT id, name, created_at FROM signers ORDER BY created_at DESC LIMIT 50'
    );

    const signerIds = signers.map((s) => s.id);
    const messages = await messagesCollection
      .find({ signer_id: { $in: signerIds } })
      .toArray();

    // Merge: attach each signer's message(s) by signer_id
    const messagesBySigner = {};
    for (const m of messages) {
      messagesBySigner[m.signer_id] = m;
    }

    const entries = signers.map((s) => ({
      name: s.name,
      created_at: s.created_at,
      message: messagesBySigner[s.id]?.message || '',
      mood: messagesBySigner[s.id]?.mood || null,
    }));

    res.json(entries);
  } catch (err) {
    console.error('Error fetching entries:', err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;

async function start() {
  await initPostgres();
  await initMongo();
  app.listen(PORT, () => console.log(`Guestbook running on port ${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start app:', err);
  process.exit(1);
});
