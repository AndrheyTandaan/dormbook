const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// This ensures we point to the file in the SAME folder as this script
const dbPath = path.join(__dirname, 'dormbook.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to open SQLite DB in init_db.js:', err.message);
        process.exit(1);
    }
});

console.log("Opening database at:", dbPath);

db.serialize(() => {
    // 1. Create Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT
    )`, (err) => { if (err) console.error("User table error:", err); else console.log("✔ Users table ready"); });

    // 2. Create Dorms
    db.run(`CREATE TABLE IF NOT EXISTS dorms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price TEXT,
        description TEXT,
        image_url TEXT
    )`, (err) => { if (err) console.error("Dorms table error:", err); else console.log("✔ Dorms table ready"); });

    // 3. Create Bookings
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        room_name TEXT,
        start_date TEXT,
        duration TEXT,
        special_request TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`, (err) => { if (err) console.error("Bookings table error:", err); else console.log("✔ Bookings table ready"); });

    // 4. Add Sample Data
    const insert = db.prepare(`INSERT INTO dorms (name, price, description, image_url) VALUES (?, ?, ?, ?)`);
    insert.run("Premium Solo Room", "5000/mo", "AC, Private Bath", "https://placehold.co/600x400?text=Premium+Solo+Room");
    insert.run("Shared Quad Room", "2500/mo", "Spacious for 4 people", "https://placehold.co/600x400?text=Shared+Quad+Room");
    insert.finalize(() => {
        console.log("✔ Sample data inserted!");
        console.log("\n🚀 Setup Complete! Your .db file should no longer be empty.");
    });
});

db.close();