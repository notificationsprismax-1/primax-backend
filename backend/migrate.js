import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run("ALTER TABLE events ADD COLUMN host_name TEXT", (err) => {
    if (err) console.log("events.host_name exists");
    else console.log("Added host_name to events");
  });
  
  db.run("ALTER TABLE host_requests ADD COLUMN host_name TEXT", (err) => {
    if (err) console.log("host_requests.host_name exists");
    else console.log("Added host_name to host_requests");
  });
  
  db.run("ALTER TABLE host_requests ADD COLUMN discord_name TEXT", (err) => {
    if (err) console.log("host_requests.discord_name exists");
    else console.log("Added discord_name to host_requests");
  });
});

setTimeout(() => db.close(), 1000);
