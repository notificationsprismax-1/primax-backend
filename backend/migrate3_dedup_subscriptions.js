import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  // Delete duplicate subscriptions keeping only the first one inserted for each user per event
  db.run(`
    DELETE FROM subscriptions
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM subscriptions
      GROUP BY event_id, email, device_id
    )
  `, function(err) {
    if (err) {
      console.error("Error deleting duplicates:", err);
    } else {
      console.log(`Successfully removed ${this.changes} duplicate subscriptions.`);
    }
  });
});

setTimeout(() => db.close(), 1000);
