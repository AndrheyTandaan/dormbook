const express = require('express');
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
const http = require('http');
const { Server } = require('socket.io');

const admin = require("firebase-admin");

let serviceAccount;

// Load Firebase credentials - try multiple methods for flexibility
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Method 1: JSON string in env var (Render recommended)
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Method 2: Path to credentials file in env var
    serviceAccount = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
} else {
    // Method 3: Local file (for local development)
    try {
        serviceAccount = require("./serviceAccountKey.json");
    } catch (error) {
        console.error(
            "Firebase credentials not found. Set FIREBASE_SERVICE_ACCOUNT_JSON env var or provide serviceAccountKey.json locally."
        );
        process.exit(1);
    }
}

const firebaseDatabaseURL = process.env.FIREBASE_DATABASE_URL;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    ...(firebaseDatabaseURL ? { databaseURL: firebaseDatabaseURL } : {}),
});

const db = admin.firestore();
const rtdb = firebaseDatabaseURL ? admin.database() : null; // Optional: use if you mirror to RTDB


// --- FIRESTORE INITIALIZATION ---
async function initializeFirestore() {
    try {
        // Seed admin user if not exists
        const adminRef = db.collection('users').doc('admin@dormbook.com');
        const adminDoc = await adminRef.get();

        if (!adminDoc.exists) {
            const hashedPass = await bcrypt.hash('09303981864', 10);
            await adminRef.set({
                id: 'admin@dormbook.com', // Using email as ID for simplicity
                name: 'System Admin',
                email: 'admin@dormbook.com',
                password: hashedPass,
                role: 'admin',
                profile_image: null,
                google_id: null,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                last_login: admin.firestore.FieldValue.serverTimestamp(),
                notif_badge_viewed_at: null
            });
            console.log('✅ Master Admin Seeded: admin@dormbook.com');
        }
    } catch (error) {
        console.error('Error initializing Firestore:', error);
    }
}

// Initialize Firestore data
initializeFirestore();

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

// --- EXPRESS SETUP ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- SOCKET.IO SETUP ---
io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
    });
});

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

passport.deserializeUser(async (id, done) => {
    try {
        const userDoc = await db.collection('users').doc(id).get();
        if (userDoc.exists) {
            done(null, { id: userDoc.id, ...userDoc.data() });
        } else {
            done(null, null);
        }
    } catch (error) {
        done(error, null);
    }
});

// Google OAuth Strategy
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: '/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    const googleId = profile.id;
    const email = profile.emails[0].value;
    const name = profile.displayName;

    try {
        // Check if user exists by google_id or email
        const usersRef = db.collection('users');
        const querySnapshot = await usersRef.where('google_id', '==', googleId).get();

        let userDoc;
        if (!querySnapshot.empty) {
            userDoc = querySnapshot.docs[0];
        } else {
            // Check by email
            const emailQuery = await usersRef.where('email', '==', email).get();
            if (!emailQuery.empty) {
                userDoc = emailQuery.docs[0];
                // Update google_id if not set
                await userDoc.ref.update({ google_id: googleId });
            }
        }

        if (userDoc) {
            return done(null, { id: userDoc.id, ...userDoc.data() });
        } else {
            // Create new user
            const newUserRef = usersRef.doc(email); // Use email as document ID
            await newUserRef.set({
                id: email,
                name: name,
                email: email,
                google_id: googleId,
                role: 'student',
                profile_image: null,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
                last_login: admin.firestore.FieldValue.serverTimestamp(),
                notif_badge_viewed_at: null
            });

            const newUserDoc = await newUserRef.get();
            return done(null, { id: newUserDoc.id, ...newUserDoc.data() });
        }
    } catch (error) {
        return done(error, null);
    }
}));

// --- LOGGING HELPER FUNCTION ---
async function logAction(adminName, details) {
    try {
        await db.collection('action_logs').add({
            admin_name: adminName || 'Admin',
            action_details: details,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error('Error logging action:', error);
    }
}

// --- FIRESTORE REALTIME BROADCAST ---
function setupRealtimeBroadcast() {
    db.collection('dorms').onSnapshot(snapshot => {
        const dorms = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('dorms:updated', dorms);
    }, err => console.error('Firestore dorms snapshot error:', err));

    db.collection('bookings').onSnapshot(snapshot => {
        const bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('bookings:updated', bookings);
    }, err => console.error('Firestore bookings snapshot error:', err));

    db.collection('users').onSnapshot(snapshot => {
        const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('users:updated', users);
    }, err => console.error('Firestore users snapshot error:', err));
}

setupRealtimeBroadcast();

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        // Check if user already exists
        const existingUser = await db.collection('users').where('email', '==', email).get();
        if (!existingUser.empty) {
            return res.status(400).json({ error: "Email already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRef = db.collection('users').doc(email);
        await userRef.set({
            id: email,
            name: name,
            email: email,
            password: hashedPassword,
            role: 'student',
            profile_image: null,
            google_id: null,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            last_login: admin.firestore.FieldValue.serverTimestamp(),
            notif_badge_viewed_at: null
        });

        res.json({ success: true, user: { id: email, name, role: 'student' } });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: "Server error" });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const userQuery = await db.collection('users').where('email', '==', email).get();
        if (userQuery.empty) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        const userDoc = userQuery.docs[0];
        const userData = userDoc.data();

        // Check password (skip for Google users)
        if (userData.google_id) {
            return res.status(400).json({ error: 'Please use Google login for this account' });
        }

        const isValidPassword = await bcrypt.compare(password, userData.password);
        if (!isValidPassword) {
            return res.status(400).json({ error: 'Invalid email or password' });
        }

        // Update last_login
        await userDoc.ref.update({
            last_login: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, user: { id: userDoc.id, name: userData.name, role: userData.role } });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: "Server error" });
    }
});

// Google Auth Routes
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth.html' }),
    async (req, res) => {
        try {
            // Update last_login
            await db.collection('users').doc(req.user.id).update({
                last_login: admin.firestore.FieldValue.serverTimestamp()
            });
            // Redirect to dashboard
            res.redirect('/index.html');
        } catch (error) {
            console.error('Google callback error:', error);
            res.redirect('/auth.html');
        }
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
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userDoc.data();

        // Check if email is already taken by another user
        if (email !== userData.email) {
            const emailQuery = await db.collection('users').where('email', '==', email).get();
            if (!emailQuery.empty) {
                return res.status(400).json({ error: 'Email already in use' });
            }
        }

        const updateData = {
            name: name,
            email: email
        };

        // Handle password change if provided
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ error: 'Current password required to change password' });
            }

            // For Google users, they don't have passwords
            if (userData.google_id) {
                return res.status(400).json({ error: 'Cannot change password for Google accounts' });
            }

            // Verify current password
            const isValidPassword = await bcrypt.compare(currentPassword, userData.password);
            if (!isValidPassword) {
                return res.status(400).json({ error: 'Current password is incorrect' });
            }

            // Hash new password
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            updateData.password = hashedPassword;
        }

        // Update user
        await userDoc.ref.update(updateData);

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));