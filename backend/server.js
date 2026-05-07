import express from 'express';
import cors from 'cors';
import pg from 'pg';
const { Pool } = pg;
import cron from 'node-cron';
import dotenv from 'dotenv';
import { addMinutes, addHours, isBefore, parseISO } from 'date-fns';
import dns from 'dns';

// Force Node.js to use IPv4 instead of IPv6 for Render compatibility
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize PostgreSQL Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('Error connecting to PostgreSQL database', err);
  } else {
    console.log('PostgreSQL Database connected successfully.');
    release();

    pool.query(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT,
      description TEXT,
      event_time TEXT, -- Stored as UTC ISO string
      type TEXT, -- 'global' or 'regional'
      status TEXT DEFAULT 'upcoming',
      host_name TEXT,
      banner_image TEXT,
      host_image TEXT
    )`).catch(console.error);

    pool.query(`CREATE TABLE IF NOT EXISTS host_requests (
      id SERIAL PRIMARY KEY,
      title TEXT,
      description TEXT,
      host_name TEXT,
      discord_name TEXT,
      status TEXT DEFAULT 'pending'
    )`).catch(console.error);

    pool.query(`CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      event_id INTEGER,
      email TEXT,
      device_id TEXT,
      reminders_sent INTEGER DEFAULT 0,
      final_reminder_time INTEGER -- 1 or 5 (minutes before)
    )`).catch(console.error);
  }
});

// Helper to convert SQLite ? to Postgres $1, $2, etc.
const convertSql = (sql) => {
  let count = 1;
  return sql.replace(/\?/g, () => `$${count++}`);
};

// Helper to run queries as promises
const runQuery = async (sql, params = []) => {
  const pgSql = convertSql(sql);
  return pool.query(pgSql, params);
};

const allQuery = async (sql, params = []) => {
  const pgSql = convertSql(sql);
  const res = await pool.query(pgSql, params);
  return res.rows;
};

// Routes
const clients = new Map();

app.get('/api/notifications/stream', (req, res) => {
  const deviceId = req.query.deviceId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Crucial for Render/Nginx to send data instantly
  res.flushHeaders();

  if (deviceId) {
    clients.set(deviceId, res);

    // Send a heartbeat every 30 seconds to keep Render connection alive
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 30000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (clients.get(deviceId) === res) {
        clients.delete(deviceId);
      }
    });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const events = await allQuery('SELECT * FROM events ORDER BY event_time ASC');
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/events/subscribe', async (req, res) => {
  const { eventId, email, deviceId, finalReminderTime } = req.body;
  try {
    // Check if already subscribed
    let query = 'SELECT id FROM subscriptions WHERE event_id = ? AND device_id = ?';
    let params = [eventId, deviceId];
    if (email) {
      query += ' AND email = ?';
      params.push(email);
    } else {
      query += ' AND email IS NULL';
    }

    const existing = await allQuery(query, params);
    if (existing && existing.length > 0) {
      return res.json({ success: true, message: 'Already subscribed' });
    }

    await runQuery('INSERT INTO subscriptions (event_id, email, device_id, final_reminder_time) VALUES (?, ?, ?, ?)', [eventId, email || null, deviceId, finalReminderTime || 5]);
    res.json({ success: true, message: 'Subscribed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/host-request', async (req, res) => {
  const { title, description, hostName, discordName } = req.body;
  try {
    await runQuery('INSERT INTO host_requests (title, description, host_name, discord_name) VALUES (?, ?, ?, ?)', [title, description, hostName, discordName]);
    res.json({ success: true, message: 'Host request submitted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.ADMIN_USER;
  const validPass = process.env.ADMIN_PASS;

  if (validUser && validPass && username === validUser && password === validPass) {
    res.json({ success: true, token: 'fake-jwt-token' });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.get('/api/admin/requests', async (req, res) => {
  try {
    const requests = await allQuery("SELECT * FROM host_requests WHERE status = 'pending'");
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/requests/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { eventTime, bannerImage, hostImage } = req.body;
  try {
    const request = (await allQuery('SELECT * FROM host_requests WHERE id = ?', [id]))[0];
    if (request && eventTime) {
      await runQuery('INSERT INTO events (title, description, event_time, type, host_name, banner_image, host_image) VALUES (?, ?, ?, ?, ?, ?, ?)', [request.title, request.description, eventTime, 'regional', request.host_name, bannerImage, hostImage]);
      await runQuery("UPDATE host_requests SET status = 'approved' WHERE id = ?", [id]);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'Request not found or missing event time' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/requests/:id/reject', async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery("UPDATE host_requests SET status = 'rejected' WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/events', async (req, res) => {
  const { title, description, eventTime, type, hostName, bannerImage, hostImage } = req.body;
  try {
    await runQuery('INSERT INTO events (title, description, event_time, type, host_name, banner_image, host_image) VALUES (?, ?, ?, ?, ?, ?, ?)', [title, description, eventTime, type, hostName, bannerImage, hostImage]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/events/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await runQuery('DELETE FROM events WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reminder Scheduler
cron.schedule('* * * * *', async () => {
  const now = new Date();

  try {
    // Check for ended events
    await runQuery("UPDATE events SET status = 'ended' WHERE event_time <= ? AND status = 'upcoming'", [now.toISOString()]);

    // Process reminders
    const subscriptions = await allQuery(`
      SELECT s.*, e.title, e.description, e.host_name, e.banner_image, e.event_time, e.type 
      FROM subscriptions s 
      JOIN events e ON s.event_id = e.id 
      WHERE e.status = 'upcoming'
    `);

    for (const sub of subscriptions) {
      const eventTime = new Date(sub.event_time);
      const istTimeFormatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'full',
        timeStyle: 'short'
      });
      const istTimeStr = istTimeFormatter.format(eventTime);
      const diffMinutes = Math.floor((eventTime - now) / 60000);

      let reminderToSend = null;

      // 6 hour reminder
      if (diffMinutes <= 360 && diffMinutes > 180 && sub.reminders_sent < 1) {
        reminderToSend = '6 Hour Reminder';
        sub.reminders_sent = 1;
      }
      // 3 hour reminder
      else if (diffMinutes <= 180 && diffMinutes > 60 && sub.reminders_sent < 2) {
        reminderToSend = '3 Hour Reminder';
        sub.reminders_sent = 2;
      }
      // 1 hour reminder
      else if (diffMinutes <= 60 && diffMinutes > 30 && sub.reminders_sent < 3) {
        reminderToSend = '1 Hour Reminder';
        sub.reminders_sent = 3;
      }
      // 30 min reminder
      else if (diffMinutes <= 30 && diffMinutes > sub.final_reminder_time && sub.reminders_sent < 4) {
        reminderToSend = '30 Min Reminder';
        sub.reminders_sent = 4;
      }
      // Final reminder (1 or 5 mins)
      else if (diffMinutes <= sub.final_reminder_time && diffMinutes >= 0 && sub.reminders_sent < 5) {
        reminderToSend = `Final ${sub.final_reminder_time} Min Reminder`;
        sub.reminders_sent = 5;
      }


      if (reminderToSend) {
        if (sub.device_id) {
          console.log(`[PUSH REMINDER: ${reminderToSend}] Sending to device ${sub.device_id} for event '${sub.title}'`);
          const clientRes = clients.get(sub.device_id);
          if (clientRes) {
            clientRes.write(`data: ${JSON.stringify({ title: sub.title, message: reminderToSend })}\n\n`);
          }
        }

        if (sub.email) {
          console.log(`[EMAIL REMINDER: ${reminderToSend}] Sending to email ${sub.email} for event '${sub.title}'`);
          const googleScriptUrl = 'https://script.google.com/macros/s/AKfycbwHnc0IDlSbJpL6r1xLeejXHVq9apYcW752g9yh_wi5XNKUFPZLbMKhVU0-emFYkhslQg/exec';
          fetch(googleScriptUrl, {
            method: 'POST',
            redirect: 'follow',
            headers: {
              'Content-Type': 'text/plain;charset=utf-8'
            },
            body: JSON.stringify({
              to: sub.email,
              subject: `PrismaX Alert: ${sub.title} is starting soon!`,
              html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; background: #000; color: #fff; border-radius: 8px;">
                  <h2 style="color: #d4af37;">PrismaX Reminder: ${sub.title}</h2>
                  <p>This is your <strong>${reminderToSend}</strong>.</p>
                  <div style="background: #111; padding: 15px; border-radius: 8px; margin: 20px 0;">
                    <p style="margin: 5px 0;"><strong>🗓️ Time (IST):</strong> ${istTimeStr}</p>
                    <p style="margin: 5px 0;"><strong>🌍 Type:</strong> <span style="text-transform: capitalize;">${sub.type}</span> Event</p>
                    ${sub.host_name ? `<p style="margin: 5px 0;"><strong>🎤 Host:</strong> ${sub.host_name}</p>` : ''}
                    <p style="margin: 15px 0 5px 0;"><strong>📝 Description:</strong></p>
                    <p style="margin: 0; color: #ccc;">${sub.description}</p>
                  </div>
                  <p>Get ready to join!</p>
                  <hr style="border: 1px solid #333;" />
                  <p style="color: #888; font-size: 12px;">You are receiving this because you subscribed to email notifications for this event.</p>
                </div>
              `
            })
          })
            .then(response => response.text())
            .then(data => {
              console.log("Email sent successfully via Google Apps Script:", data);
            })
            .catch(err => console.error("Failed to send email via Google Apps Script:", err));
        }

        await runQuery('UPDATE subscriptions SET reminders_sent = ? WHERE id = ?', [sub.reminders_sent, sub.id]);
      }
    }
  } catch (error) {
    console.error('Scheduler error:', error);
  }
});

app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});
