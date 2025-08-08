import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import fs from 'fs';
import { exec } from 'child_process';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 4000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MONGO_URI = process.env.MONGO_URI || '';
const SELF_TOKEN = process.env.SELF_UPDATE_TOKEN || 'changeme';

let dbSQLite;
let mongoClient;
let mongoCollection;

async function initDB() {
  dbSQLite = await open({ filename: './data/db.sqlite', driver: sqlite3.Database });
  await dbSQLite.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, text TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  if (MONGO_URI) {
    try {
      mongoClient = new MongoClient(MONGO_URI);
      await mongoClient.connect();
      const db = mongoClient.db();
      mongoCollection = db.collection('messages');
    } catch (err) {
      console.error('Mongo connect error', err);
    }
  }
}

function saveMessage(role, text) {
  try {
    dbSQLite.run('INSERT INTO messages (role, text) VALUES (?, ?)', [role, text]);
  } catch (e) { console.error(e); }
  if (mongoCollection) {
    try { mongoCollection.insertOne({ role, text, createdAt: new Date() }); } catch(e){ console.error(e); }
  }
}

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Invalid message' });
  saveMessage('user', message);
  try {
    if (OPENAI_KEY) {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: message }], max_tokens: 300 })
      });
      const j = await resp.json();
      const answer = j?.choices?.[0]?.message?.content || (j.error || JSON.stringify(j));
      saveMessage('bot', answer);
      return res.json({ answer });
    } else {
      // simple offline responder
      let answer = 'Villain echo: ' + message;
      if (/hello|hi|vanakkam/i.test(message)) answer = 'Vanakkam! How can Villain help you?';
      saveMessage('bot', answer);
      return res.json({ answer });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err) });
  }
});

// Self-update: takes { token, instruction } -> appends to backend/auto_generated.js and attempts git commit + pm2 restart
app.post('/api/self-update', async (req, res) => {
  const { token, instruction } = req.body || {};
  if (!token || token !== SELF_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  if (!instruction || typeof instruction !== 'string') return res.status(400).json({ error: 'No instruction' });
  try {
    const filePath = './backend/auto_generated.js';
    const header = `// Auto-generated snippet — appended by self-update\n// Instruction: ${instruction}\n`;
    const content = `\n// ---------- START SNIPPET ----------\n// ${new Date().toISOString()}\nconsole.log('Auto snippet: ${instruction.replace(/'/g, "\\'")}');\n// ---------- END SNIPPET ----------\n`;
    fs.appendFileSync(filePath, header + content, { encoding: 'utf8' });

    // Attempt git commit + push (if repo remote configured)
    exec('git add . && git commit -m "Auto-update: ' + instruction.replace(/"/g, '\"') + '" || true', (err, stdout, stderr) => {
      if (err) console.error('git commit error', err);
      // Try push if remote exists
      exec('git push || true', (err2, out2, errout2) => {
        if (err2) console.error('git push err', err2);
      });
    });

    // Try restart via PM2, else graceful exit to allow process manager restart
    exec('pm2 restart villain', (pmErr) => {
      if (pmErr) {
        console.log('pm2 restart failed, exiting process to let supervisor restart');
        setTimeout(() => process.exit(0), 1000);
      }
    });

    return res.json({ status: 'ok', message: 'Applied instruction, committed file, attempting restart' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

// expose logs/messages simple endpoint
app.get('/api/messages', async (req, res) => {
  try {
    const rows = await dbSQLite.all('SELECT id, role, text, created_at FROM messages ORDER BY id DESC LIMIT 200');
    return res.json({ messages: rows });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

(async () => {
  try {
    await initDB();
    // ensure auto_generated file exists
    if (!fs.existsSync('./backend/auto_generated.js')) fs.writeFileSync('./backend/auto_generated.js', '// Auto-generated snippets\n', 'utf8');
    app.listen(PORT, () => console.log(`Villain backend running on port ${PORT}`));
  } catch (err) {
    console.error('Init error', err);
  }
})();
