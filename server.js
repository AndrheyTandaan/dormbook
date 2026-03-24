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
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// --- REQUEST LOGGER MIDDLEWARE ---
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- STATIC FILES (AFTER API ROUTES WILL BE DEFINED) ---
// We'll move this AFTER all API routes are defined

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

// Get current session user (for checking if user is logged in via Google/Passport)
app.get('/api/session-user', (req, res) => {
    if (req.user) {
        res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role } });
    } else {
        res.json({ user: null });
    }
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
app.get('/api/admin/users', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').orderBy('created_at', 'desc').get();
        const users = usersSnapshot.docs.map(doc => ({
            id: doc.id,
            name: doc.data().name,
            email: doc.data().email,
            role: doc.data().role,
            created_at: doc.data().created_at
        }));
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
        const userData = userDoc.data();
        res.json({
            id: userDoc.id,
            name: userData.name,
            email: userData.email,
            role: userData.role,
            created_at: userData.created_at,
            last_login: userData.last_login
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/users/:id/last_login', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('users').doc(id).update({
            last_login: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/users/:id/notif-badge-viewed', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('users').doc(id).update({
            notif_badge_viewed_at: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, viewed_at: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/users/:id/notif-badge-status', async (req, res) => {
    try {
        const { id } = req.params;
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
        const userData = userDoc.data();
        res.json({
            viewed: userData.notif_badge_viewed_at !== null,
            viewed_at: userData.notif_badge_viewed_at
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/users/:id/role', async (req, res) => {
    try {
        const { id } = req.params;
        const { role, adminName } = req.body;
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const userData = userDoc.data();
        await db.collection('users').doc(id).update({ role });
        logAction(adminName, `Changed role of ${userData.name} to ${role}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const adminName = req.query.adminName;
        const userDoc = await db.collection('users').doc(id).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const userData = userDoc.data();
        await db.collection('users').doc(id).delete();
        logAction(adminName, `Deleted user: ${userData.name}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- DORM ROUTES ---
app.get('/api/dorms', async (req, res) => {
    try {
        // Get all dorms
        const dormsSnapshot = await db.collection('dorms').get();
        const dorms = [];

        for (const dormDoc of dormsSnapshot.docs) {
            const dormData = dormDoc.data();
            // Check if dorm is occupied by counting approved bookings
            const bookingsSnapshot = await db.collection('bookings')
                .where('room_name', '==', dormData.name)
                .where('status', '==', 'Approved')
                .get();

            dorms.push({
                id: dormDoc.id,
                ...dormData,
                is_occupied: !bookingsSnapshot.empty
            });
        }

        res.json(dorms);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/rooms', async (req, res) => {
    try {
        const dormsSnapshot = await db.collection('dorms').get();
        const dorms = dormsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(dorms);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATED: Added room_type to INSERT
app.post('/api/dorms', async (req, res) => {
    try {
        const { name, price, description, image_url, room_type, adminName } = req.body;
        const dormRef = await db.collection('dorms').add({
            name,
            price: parseFloat(price),
            description,
            image_url,
            room_type,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        logAction(adminName, `Added new dorm: ${name} (${room_type})`);
        res.json({ success: true, id: dormRef.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// UPDATED: Added room_type to UPDATE
app.put('/api/dorms/:id', async (req, res) => {
    try {
        const { name, price, description, image_url, room_type, adminName } = req.body;
        const id = req.params.id;
        await db.collection('dorms').doc(id).update({
            name,
            price: parseFloat(price),
            description,
            image_url,
            room_type
        });
        logAction(adminName, `Updated dorm: ${name}`);
        res.json({ success: true, message: "Dorm updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/dorms/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const adminName = req.query.adminName;
        const dormDoc = await db.collection('dorms').doc(id).get();
        if (!dormDoc.exists) return res.status(404).json({ error: "Dorm not found" });
        const dormData = dormDoc.data();
        await db.collection('dorms').doc(id).delete();
        logAction(adminName, `Deleted dorm: ${dormData.name}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- ACTION LOG ROUTE ---
app.get('/api/admin/logs', async (req, res) => {
    try {
        const logsSnapshot = await db.collection('action_logs').orderBy('timestamp', 'desc').get();
        const logs = logsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(logs);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- BOOKING ROUTES ---
app.get('/api/admin/bookings', async (req, res) => {
    try {
        const bookingsSnapshot = await db.collection('bookings').orderBy('created_at', 'desc').get();
        const bookings = [];

        for (const bookingDoc of bookingsSnapshot.docs) {
            const bookingData = bookingDoc.data();

            // Get user name
            let userName = 'Unknown User';
            try {
                const userDoc = await db.collection('users').doc(bookingData.user_id).get();
                if (userDoc.exists) {
                    userName = userDoc.data().name;
                }
            } catch (error) {
                console.error('Error fetching user for booking:', error);
            }

            // Get dorm price
            let price = 0;
            try {
                const dormQuery = await db.collection('dorms').where('name', '==', bookingData.room_name).limit(1).get();
                if (!dormQuery.empty) {
                    price = dormQuery.docs[0].data().price || 0;
                }
            } catch (error) {
                console.error('Error fetching dorm price for booking:', error);
            }

            bookings.push({
                id: bookingDoc.id,
                ...bookingData,
                user_name: userName,
                price: price
            });
        }

        res.json(bookings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/book', upload.single('receipt'), async (req, res) => {
    try {
        const { user_id, room_name, start_date, duration, special_request, amount_paid } = req.body;
        const receipt_url = req.file ? `/uploads/receipts/${req.file.filename}` : null;

        if (!user_id || !room_name) return res.status(400).json({ error: "Missing required booking data." });

        const bookingRef = await db.collection('bookings').add({
            user_id,
            room_name,
            start_date,
            duration: parseInt(duration),
            special_request,
            receipt_url,
            amount_paid: parseFloat(amount_paid) || 0,
            status: 'Pending',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, bookingId: bookingRef.id });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/bookings/user/:userId', async (req, res) => {
    try {
        const bookingsSnapshot = await db.collection('bookings')
            .where('user_id', '==', req.params.userId)
            .orderBy('created_at', 'desc')
            .get();
        const bookings = bookingsSnapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
        res.json(bookings || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/bookings/:id/status', async (req, res) => {
    try {
        const { status, adminName } = req.body;
        const id = req.params.id;

        if (!status) {
            return res.status(400).json({ error: "Status is required" });
        }

        const bookingDoc = await db.collection('bookings').doc(id).get();
        if (!bookingDoc.exists) {
            return res.status(404).json({ error: "Booking not found" });
        }

        const bookingData = bookingDoc.data();

        // Get user name for logging
        let userName = 'Unknown User';
        try {
            const userDoc = await db.collection('users').doc(bookingData.user_id).get();
            if (userDoc.exists) {
                userName = userDoc.data().name;
            }
        } catch (error) {
            console.error('Error fetching user:', error);
        }

        await db.collection('bookings').doc(id).update({ status });
        logAction(adminName, `Updated booking status for ${userName} (${bookingData.room_name}) to ${status}`);

        return res.status(200).json({ success: true, message: 'Status updated' });
    } catch (error) {
        console.error('Booking status update error:', error);
        return res.status(500).json({ error: error.message || 'Server error' });
    }
});

app.delete('/api/bookings/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const adminName = req.query.adminName;

        const bookingDoc = await db.collection('bookings').doc(id).get();
        if (!bookingDoc.exists) {
            res.setHeader('Content-Type', 'application/json');
            return res.status(404).json({ error: "Booking not found" });
        }

        const bookingData = bookingDoc.data();

        // Get user name for logging
        let studentName = 'Student';
        try {
            const userDoc = await db.collection('users').doc(bookingData.user_id).get();
            if (userDoc.exists) {
                studentName = userDoc.data().name;
            }
        } catch (error) {
            console.error('Error fetching user for booking deletion:', error);
        }

        await db.collection('bookings').doc(id).delete();
        const logMsg = `Deleted booking: ${studentName} for ${bookingData.room_name}`;
        logAction(adminName, logMsg);
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true });
    } catch (error) {
        console.error('Booking deletion error:', error);
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: error.message });
    }
});

// --- STATIC FILES MIDDLEWARE (AFTER ALL API ROUTES) ---
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- CATCH-ALL ---
app.use((req, res) => {
    console.log(`[CATCH-ALL] ${req.method} ${req.path} - Route not found`);
    const filePath = path.join(__dirname, 'public', req.path);
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        // Set proper content type for HTML files
        if (filePath.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        }
        res.sendFile(filePath);
    } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));