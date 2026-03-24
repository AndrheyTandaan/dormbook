const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
require('dotenv').config();
const { OAuth2Client } = require('google-auth-library');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
const db = new sqlite3.Database('./db/dormbook.db');

// --- MULTER CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public', 'uploads', 'receipts');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Profile image upload configuration
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'public', 'uploads', 'profiles');
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const userId = req.params.id;
        const ext = path.extname(file.originalname);
        cb(null, `profile-${userId}${ext}`);
    }
});
const uploadProfile = multer({
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

// --- DATABASE INITIALIZATION & ADMIN SEEDING ---
db.serialize(async () => {
    // 1. Create Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'student',
        profile_image TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME DEFAULT CURRENT_TIMESTAMP,
        notif_badge_viewed_at DATETIME
    )`);

    // Ensure google_id column exists
    db.run(`ALTER TABLE users ADD COLUMN google_id TEXT`, (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add google_id column:', err.message);
        }
    });

    // Ensure profile_image column exists
    db.run(`ALTER TABLE users ADD COLUMN profile_image TEXT`, (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add profile_image column:', err.message);
        }
    });

    // Ensure last_login column exists even when table created before this change
    db.run(`ALTER TABLE users ADD COLUMN last_login DATETIME`, (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add last_login column:', err.message);
        }
    });

    // Ensure notif_badge_viewed_at column exists for notification badge tracking
    db.run(`ALTER TABLE users ADD COLUMN notif_badge_viewed_at DATETIME`, (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
            console.warn('Could not add notif_badge_viewed_at column:', err.message);
        }
    });

    // 2. SEED MASTER ADMIN ACCOUNT
    const adminEmail = 'admin@dormbook.com';
    const adminPass = '09303981864';
    
    db.get(`SELECT * FROM users WHERE email = ?`, [adminEmail], async (err, row) => {
        if (!row) {
            const hashedPass = await bcrypt.hash(adminPass, 10);
            db.run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)`,
                ['System Admin', adminEmail, hashedPass, 'admin'], (err) => {
                    if (!err) console.log(`✅ Master Admin Seeded: ${adminEmail}`);
                });
        }
    });

    // UPDATED: Added room_type column
    db.run(`CREATE TABLE IF NOT EXISTS dorms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price TEXT,
        description TEXT,
        image_url TEXT,
        room_type TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        room_name TEXT,
        start_date TEXT,
        duration TEXT,
        special_request TEXT,
        receipt_url TEXT,
        amount_paid REAL DEFAULT 0,
        status TEXT DEFAULT 'Pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS action_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_name TEXT,
        action_details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- SESSION & PASSPORT SETUP ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport serialize/deserialize
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => {
        done(err, row);
    });
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
    const googleId = profile.id;
    const email = profile.emails[0].value;
    const name = profile.displayName;

    db.get(`SELECT * FROM users WHERE google_id = ? OR email = ?`, [googleId, email], (err, row) => {
        if (err) return done(err);
        if (row) {
            // Update google_id if not set
            if (!row.google_id) {
                db.run(`UPDATE users SET google_id = ? WHERE id = ?`, [googleId, row.id]);
            }
            return done(null, row);
        } else {
            // Create new user
            db.run(`INSERT INTO users (name, email, google_id, role) VALUES (?, ?, ?, 'student')`,
                [name, email, googleId], function(err) {
                    if (err) return done(err);
                    db.get(`SELECT * FROM users WHERE id = ?`, [this.lastID], (err, newRow) => {
                        done(err, newRow);
                    });
                });
        }
    });
}));

// --- LOGGING HELPER FUNCTION ---
function logAction(adminName, details) {
    db.run(`INSERT INTO action_logs (admin_name, action_details) VALUES (?, ?)`, [adminName || 'Admin', details]);
}

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'student')`,
            [name, email, hashedPassword], function(err) {
                if (err) return res.status(400).json({ error: "Email already exists" });
                res.json({ success: true, user: { id: this.lastID, name, role: 'student' } });
            });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, row) => {
        if (err || !row || !(await bcrypt.compare(password, row.password))) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }
        db.run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
        res.json({ success: true, user: { id: row.id, name: row.name, role: row.role } });
    });
});

// Google Auth Routes
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth.html' }),
    (req, res) => {
        // Update last_login
        db.run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [req.user.id]);
        // Redirect to dashboard
        res.redirect('/index.html');
    }
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/auth.html');
    });
});

app.put('/api/users/:id/profile', async (req, res) => {
    const { id } = req.params;
    const { name, email, currentPassword, newPassword } = req.body;

    try {
        // Get current user data
        const user = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) return res.status(404).json({ error: 'User not found' });

        // Check if email is already taken by another user
        const existingUser = await new Promise((resolve, reject) => {
            db.get(`SELECT id FROM users WHERE email = ? AND id != ?`, [email, id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (existingUser) return res.status(400).json({ error: 'Email already in use' });

        let updateFields = ['name = ?', 'email = ?'];
        let updateValues = [name, email];

        // Handle password change if provided
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ error: 'Current password required to change password' });
            }

            // For Google users, they don't have passwords
            if (user.google_id) {
                return res.status(400).json({ error: 'Cannot change password for Google accounts' });
            }

            // Verify current password
            const isValidPassword = await bcrypt.compare(currentPassword, user.password);
            if (!isValidPassword) {
                return res.status(400).json({ error: 'Current password is incorrect' });
            }

            // Hash new password
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            updateFields.push('password = ?');
            updateValues.push(hashedPassword);
        }

        updateValues.push(id);

        // Update user
        await new Promise((resolve, reject) => {
            db.run(`UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`, updateValues, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- USER MANAGEMENT ROUTES ---
app.get('/api/admin/users', (req, res) => {
    db.all(`SELECT id, name, email, role, created_at FROM users ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/users/:id', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT id, name, email, role, created_at, last_login FROM users WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
    });
});

app.patch('/api/users/:id/last_login', (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    });
});

app.patch('/api/users/:id/notif-badge-viewed', (req, res) => {
    const { id } = req.params;
    db.run(`UPDATE users SET notif_badge_viewed_at = CURRENT_TIMESTAMP WHERE id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, viewed_at: new Date().toISOString() });
    });
});

app.get('/api/users/:id/notif-badge-status', (req, res) => {
    const { id } = req.params;
    db.get(`SELECT notif_badge_viewed_at FROM users WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json({ 
            viewed: row.notif_badge_viewed_at !== null,
            viewed_at: row.notif_badge_viewed_at 
        });
    });
});

app.put('/api/admin/users/:id/role', (req, res) => {
    const { id } = req.params;
    const { role, adminName } = req.body;
    db.get(`SELECT name FROM users WHERE id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "User not found" });
        db.run(`UPDATE users SET role = ? WHERE id = ?`, [role, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `Changed role of ${row.name} to ${role}`);
            res.json({ success: true });
        });
    });
});

app.delete('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    const adminName = req.query.adminName;
    db.get(`SELECT name FROM users WHERE id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "User not found" });
        const userName = row.name;
        db.run(`DELETE FROM users WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `Deleted user: ${userName}`);
            res.json({ success: true });
        });
    });
});

// --- DORM ROUTES ---
app.get('/api/dorms', (req, res) => {
    const query = `
        SELECT dorms.*, 
        (SELECT COUNT(*) FROM bookings WHERE bookings.room_name = dorms.name AND bookings.status = 'Approved') as is_occupied
        FROM dorms
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/rooms', (req, res) => {
    db.all(`SELECT * FROM dorms`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// UPDATED: Added room_type to INSERT
app.post('/api/dorms', (req, res) => {
    const { name, price, description, image_url, room_type, adminName } = req.body;
    db.run(`INSERT INTO dorms (name, price, description, image_url, room_type) VALUES (?, ?, ?, ?, ?)`,
        [name, price, description, image_url, room_type], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `Added new dorm: ${name} (${room_type})`);
            res.json({ success: true, id: this.lastID });
        });
});

// UPDATED: Added room_type to UPDATE
app.put('/api/dorms/:id', (req, res) => {
    const { name, price, description, image_url, room_type, adminName } = req.body;
    const id = req.params.id;
    db.run(`UPDATE dorms SET name = ?, price = ?, description = ?, image_url = ?, room_type = ? WHERE id = ?`,
        [name, price, description, image_url, room_type, id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `Updated dorm: ${name}`);
            res.json({ success: true, message: "Dorm updated" });
        });
});

app.delete('/api/dorms/:id', (req, res) => {
    const id = req.params.id;
    const adminName = req.query.adminName;
    db.get(`SELECT name FROM dorms WHERE id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Dorm not found" });
        const dormName = row.name;
        db.run(`DELETE FROM dorms WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `Deleted dorm: ${dormName}`);
            res.json({ success: true });
        });
    });
});

// --- ACTION LOG ROUTE ---
app.get('/api/admin/logs', (req, res) => {
    db.all(`SELECT * FROM action_logs ORDER BY timestamp DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- BOOKING ROUTES ---
app.get('/api/admin/bookings', (req, res) => {
    const query = `
        SELECT 
            bookings.*, 
            users.name as user_name,
            dorms.price as price
        FROM bookings 
        LEFT JOIN users ON bookings.user_id = users.id
        LEFT JOIN dorms ON bookings.room_name = dorms.name
        ORDER BY bookings.id DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/book', upload.single('receipt'), (req, res) => {
    const { user_id, room_name, start_date, duration, special_request, amount_paid } = req.body;
    const receipt_url = req.file ? `/uploads/receipts/${req.file.filename}` : null;
    
    if (!user_id || !room_name) return res.status(400).json({ error: "Missing required booking data." });
    
    const sql = `INSERT INTO bookings (user_id, room_name, start_date, duration, special_request, receipt_url, amount_paid, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending')`;
    
    db.run(sql, [user_id, room_name, start_date, duration, special_request, receipt_url, amount_paid || 0], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ success: true, bookingId: this.lastID });
    });
});

app.get('/api/bookings/user/:userId', (req, res) => {
    db.all(`SELECT * FROM bookings WHERE user_id = ? ORDER BY id DESC`, [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.patch('/api/bookings/:id/status', (req, res) => {
    const { status, adminName } = req.body;
    const id = req.params.id;
    db.get(`SELECT b.room_name, u.name FROM bookings b JOIN users u ON b.user_id = u.id WHERE b.id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Booking not found" });
        db.run(`UPDATE bookings SET status = ? WHERE id = ?`, [status, id], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, `${status} booking: ${row.name} for ${row.room_name}`);
            res.json({ success: true });
        });
    });
});

app.delete('/api/bookings/:id', (req, res) => {
    const id = req.params.id;
    const adminName = req.query.adminName;
    db.get(`SELECT b.room_name, u.name as student_name FROM bookings b LEFT JOIN users u ON b.user_id = u.id WHERE b.id = ?`, [id], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Booking not found" });
        const logMsg = `Deleted booking: ${row.student_name || 'Student'} for ${row.room_name}`;
        db.run(`DELETE FROM bookings WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            logAction(adminName, logMsg);
            res.json({ success: true });
        });
    });
});

// --- CATCH-ALL ---
app.get(/^/, (req, res) => {
    const filePath = path.join(__dirname, 'public', req.path);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        res.sendFile(filePath);
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

app.listen(3000, () => console.log('🚀 Server running at http://localhost:3000'));