import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run("ALTER TABLE events ADD COLUMN banner_image TEXT", (err) => {
    if (err) console.log("events.banner_image exists");
    else console.log("Added banner_image to events");
  });
  
  db.run("ALTER TABLE events ADD COLUMN host_image TEXT", (err) => {
    if (err) console.log("events.host_image exists");
    else console.log("Added host_image to events");
  });
});

setTimeout(() => db.close(), 1000);
