import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server as IOServer } from "socket.io";
import OpenAI from "openai"; // your existing chatbot usage (kept)
import nodemailer from "nodemailer";
import sqlite3 from "sqlite3";
import bcrypt from "bcryptjs";
import bodyParser from "body-parser";


dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// serve static files from 'public' directory
app.use(express.static('public'));
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// Database setup
const db = new sqlite3.Database("./users.db");

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT UNIQUE,
  password TEXT
)`);

// In-memory registry of tracked apps (prototype). Format:
// registeredTracks[app_id] = { app_id, scholarship, name, contact, consent, registeredAt }
const registeredTracks = {};

// Create nodemailer transporter using env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: (process.env.SMTP_SECURE === 'true'),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// quick email validator
function looksLikeEmail(s){ return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }

// create http + socket.io
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: "*" }
});

// --- your existing Chatbot route ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: userMessage }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error("OpenAI error:", data.error);
      return res.status(500).json({ error: data.error.message });
    }

    res.json({ reply: data.choices[0].message.content });
  } catch (err) {
    console.error("Chat API error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --- Tracking webhook (ADMIN authenticated) ---
const ADMIN_KEY = process.env.ADMIN_KEY || 'demo_admin_secret_123';
function checkAdminKey(req, res, next){
  const key = req.header('x-admin-key') || req.body.admin_key || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized — invalid admin key' });
  return next();
}

// register a tracking request (called by frontend when user starts tracking)
app.post('/register', (req, res) => {
  try {
    const { app_id, scholarship, name, contact, consent } = req.body || {};
    if (!app_id) return res.status(400).json({ error: 'app_id required' });
    if (!consent) return res.status(400).json({ error: 'consent required' });

    // Only store if contact is an email (we will email). For phone, you can store for SMS later
    if (contact && looksLikeEmail(contact)) {
      registeredTracks[String(app_id)] = {
        app_id: String(app_id),
        scholarship: scholarship || '',
        name: name || '',
        contact: contact,
        consent: true,
        registeredAt: new Date().toISOString()
      };
      console.log('Registered tracking for', app_id, contact);
      return res.json({ ok: true });
    } else {
      // still accept registration but without email
      registeredTracks[String(app_id)] = {
        app_id: String(app_id),
        scholarship: scholarship || '',
        name: name || '',
        contact: contact || '',
        consent: !!consent,
        registeredAt: new Date().toISOString()
      };
      return res.json({ ok: true, warning: 'contact not a valid email; no emails will be sent' });
    }
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ error: 'server error' });
  }
});

app.post('/webhook/update', checkAdminKey, async (req, res) => {
  const { app_id, status, note, scholarship, name, contact, ts } = req.body || {};
  if (!app_id || !status) return res.status(400).json({ error: 'app_id and status required' });

  const payload = {
    app_id: String(app_id),
    status: String(status),
    note: note || '',
    scholarship: scholarship || '',
    name: name || '',
    contact: contact || '',
    ts: ts || new Date().toISOString()
  };

  // broadcast to sockets
  io.emit('statusUpdate', payload);
  console.log('Broadcasted update:', payload.app_id, payload.status);

  // If we have a registered contact for this app_id and it's an email → send email
  try {
    const reg = registeredTracks[String(app_id)];
    if (reg && reg.contact && looksLikeEmail(reg.contact) && reg.consent) {
      // build email (both EN + HI short)
      const subject = `Update: ${payload.status} — ${payload.app_id}`;
      const trackUrl = `${process.env.SITE_ORIGIN || ('http://localhost:' + (process.env.PORT || 5000))}/?track=${encodeURIComponent(app_id)}`;
      const text = `
Hello ${reg.name || 'Applicant'},

This is an update for your application ${payload.app_id} (${reg.scholarship || payload.scholarship || ''}).

Status: ${payload.status}
Time: ${new Date(payload.ts).toLocaleString()}
Note: ${payload.note || '—'}

Track online: ${trackUrl}

If you do not wish to receive further emails, reply STOP or contact support.
Regards,
Social Awareness Hub
      `;

      const html = `
<p>Hello ${reg.name || 'Applicant'},</p>
<p><strong>Update for your application ${payload.app_id}</strong> (${reg.scholarship || payload.scholarship || ''})</p>
<ul>
  <li><strong>Status:</strong> ${payload.status}</li>
  <li><strong>Time:</strong> ${new Date(payload.ts).toLocaleString()}</li>
  <li><strong>Note:</strong> ${payload.note || '—'}</li>
</ul>
<p><a href="${trackUrl}">Click here to view your timeline</a></p>
<hr/>
<p style="font-size:0.9em;color:#666">यदि आप आगे ईमेल प्राप्त नहीं करना चाहते, तो हमें बताएं। / अगर आप ईमेल बंद करना चाहते हैं तो reply करें STOP।</p>
<p>Social Awareness Hub</p>
      `;

      // send
      await transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: reg.contact,
        subject,
        text,
        html
      });
      console.log('Email sent to', reg.contact, 'for', app_id);
    }
  } catch (err) {
    console.error('Email send error:', err?.message || err);
    // do not fail webhook because of email error
  }

  return res.json({ ok: true, payload });
});

// --- user register page  backend ---
app.post("/register-user", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "All fields required" });

  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [name, email, hashed],
      function (err) {
        if (err) {
          return res.status(400).json({ error: "Email already registered" });
        }
        res.json({ success: true, id: this.lastID });
      }
    );
  } catch (e) {
    res.status(500).json({ error: "Server error" });
  }
});

// --- user login page backend ---
app.post("/login-user", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "All fields required" });

  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid credentials" });

    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  });
});

// --- logout route ---
app.post("/logout", (req, res) => {
  res.json({ success: true, message: "Logged out" });
});  


// --- Admin: Send Notification to multiple emails ---
app.post('/admin/sendNotification', checkAdminKey, async (req, res) => {
  const { emails, message } = req.body || {};

  if (!emails || !Array.isArray(emails) || !emails.length) {
    return res.status(400).json({ error: "At least one email required" });
  }
  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    for (let email of emails) {
      if (looksLikeEmail(email)) {
        await transporter.sendMail({
          from: process.env.FROM_EMAIL,
          to: email,
          subject: "Scholarship Notification",
          text: message,
          html: `<p>${message}</p>`
        });
        console.log("Notification sent to", email);
      }
    }
    return res.json({ success: true, sent: emails.length });
  } catch (err) {
    console.error("Notification send error:", err.message || err);
    return res.status(500).json({ error: "Failed to send emails" });
  }
});

// --- Table of Booked Appointments ---
db.run(`
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    contact TEXT,
    email TEXT,
    address TEXT,
    query TEXT,
    time TEXT,
    reference TEXT,
    status TEXT DEFAULT 'Pending'
  )
`);



// ---- Appointment APIs ----
// Confirm an appointment
app.post('/appointments/:id/confirm', (req, res) => {
  const id = req.params.id;
  db.run("UPDATE appointments SET status='Confirmed' WHERE id=?", [id], function(err) {
    if (err) return res.status(500).json({ error: "confirmed" });
    res.json({ success: true });
  });
});

// Save new appointment
app.post('/appointments', (req, res) => {
  const { name, contact, email, address, query, time } = req.body;

  if (!name || !contact || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // // agar reference rakhna hai:
  const reference = "REF" + Date.now();

  db.run(
    `INSERT INTO appointments 
      (name, contact, email, address, query, time, reference) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, contact, email, address, query, time, reference],
    function(err) {
      if (err) {
        console.error("DB insert error:", err);
        return res.status(500).json({ error: "Database error" });
      }
      res.json({ success: true, id: this.lastID, reference });
    }
  );
});


// Update reference number after payment
app.post('/appointments/ref', (req, res) => {
  const { id, reference } = req.body;
  if (!id || !reference) return res.status(400).json({ error: "Missing data" });

  db.run("UPDATE appointments SET reference=? WHERE id=?", [reference, id], function (err) {
    if (err) return res.status(500).json({ error: "DB update failed" });
    res.json({ success: true });
  });
});

// Get all appointments (for admin panel)
app.get('/appointments/list', (req, res) => {
  db.all("SELECT * FROM appointments", [], (err, rows) => {
    if (err) return res.status(500).json({ error: "DB fetch failed" });
    res.json(rows);
  });
});
// Delete an appointment
app.delete('/appointments/:id', (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM appointments WHERE id=?", [id], function (err) {
    if (err) return res.status(500).json({ error: "DB delete failed" });
    res.json({ success: true, deleted: this.changes });
  });
});


const PORT = process.env.PORT || 5001;
httpServer.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}  (ADMIN_KEY=${ADMIN_KEY})`));
