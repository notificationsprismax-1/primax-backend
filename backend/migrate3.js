import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run("ALTER TABLE subscriptions ADD COLUMN device_id TEXT", (err) => {
    if (err) console.log("subscriptions.device_id exists");
    else console.log("Added device_id to subscriptions");
  });
});

setTimeout(() => db.close(), 1000);
