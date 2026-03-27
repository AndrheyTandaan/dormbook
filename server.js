const express = require('express');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
require('dotenv').config();
const session = require('express-session');
const passport = require('passport');
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

// --- LOGGING HELPER FUNCTION ---
async function logAction(adminName, details) {
    try {
        await db.collection('action_logs').add({
            admin_name: adminName || 'Admin',
            action_details: details,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Emit action log update for realtime admin view
        const logsSnapshot = await db.collection('action_logs').orderBy('timestamp','desc').get();
        const logs = logsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('action_logs:updated', logs);
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

    db.collection('action_logs').onSnapshot(snapshot => {
        const logs = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        io.emit('action_logs:updated', logs);
    }, err => console.error('Firestore action_logs snapshot error:', err));
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

// Forgot Password Route
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    try {
        // Check if user exists
        const userQuery = await db.collection('users').where('email', '==', email).get();
        if (userQuery.empty) {
            // Don't reveal if email exists or not for security
            return res.json({ success: true, message: 'If the email exists, a reset link has been sent.' });
        }

        const userDoc = userQuery.docs[0];
        const userData = userDoc.data();

        // Generate reset token
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetTokenExpiry = Date.now() + 3600000; // 1 hour

        // Store reset token in user document
        await userDoc.ref.update({
            resetToken: resetToken,
            resetTokenExpiry: resetTokenExpiry
        });

        // Send email using EmailJS
        try {
            const emailjs = require('@emailjs/nodejs');
            
            // Get credentials from environment variables
            const publicKey = process.env.EMAILJS_PUBLIC_KEY;
            const privateKey = process.env.EMAILJS_PRIVATE_KEY;
            const serviceId = process.env.EMAILJS_SERVICE_ID;
            const templateId = process.env.EMAILJS_TEMPLATE_ID;

            console.log('[EmailJS] Checking credentials:', {
                hasPublicKey: !!publicKey,
                hasPrivateKey: !!privateKey,
                hasServiceId: !!serviceId,
                hasTemplateId: !!templateId
            });

            if (!publicKey || !privateKey || !serviceId || !templateId) {
                throw new Error('EmailJS credentials not configured in environment');
            }

            // Initialize EmailJS with credentials from .env
            emailjs.init({
                publicKey: publicKey,
                privateKey: privateKey
            });
            console.log('[EmailJS] Initialized successfully');

            const appUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const resetLink = `${appUrl}/reset-password.html?token=${resetToken}`;

            const templateParams = {
                to_email: email,
                user_name: userData.name,
                reset_link: resetLink
            };

            console.log('[EmailJS] Sending with params:', { to_email: email, serviceId, templateId });

            await emailjs.send(serviceId, templateId, templateParams);
            console.log(`[EmailJS] Email sent successfully to ${email}`);
            res.json({ success: true, message: 'Reset link sent to your email.' });

        } catch (emailError) {
            console.error('[EmailJS] Email sending failed:', emailError);
            console.error('[EmailJS] Error details:', {
                message: emailError.message,
                stack: emailError.stack,
                toString: emailError.toString()
            });
            // Fallback: return reset link if email fails
            const appUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
            const resetLink = `${appUrl}/reset-password.html?token=${resetToken}`;
            res.json({
                success: true,
                message: 'Email sending failed. Use this reset link:',
                resetLink: resetLink,
                note: 'Check your EmailJS configuration.'
            });
        }

    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ error: "Server error" });
    }
});

// Reset Password Route
app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).json({ error: 'Token and password are required' });
    }

    // enforce reasonable password policy
    const passwordPolicy = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/;
    if (!passwordPolicy.test(password)) {
        return res.status(400).json({
            error: 'Password must be at least 8 characters, include uppercase, lowercase, number, and symbol.'
        });
    }

    try {
        // Find user with matching reset token
        const userQuery = await db.collection('users').where('resetToken', '==', token).get();
        if (userQuery.empty) {
            return res.status(400).json({ error: 'Invalid or expired reset token' });
        }

        const userDoc = userQuery.docs[0];
        const userData = userDoc.data();

        // Check if token is expired
        if (!userData.resetTokenExpiry || Date.now() > userData.resetTokenExpiry) {
            return res.status(400).json({ error: 'Reset token has expired' });
        }

        // Ensure token is not reused from another session (extra safeties)
        if (userData.resetToken !== token) {
            return res.status(400).json({ error: 'Invalid reset token' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Update password and clear reset token
        await userDoc.ref.update({
            password: hashedPassword,
            resetToken: null,
            resetTokenExpiry: null
        });

        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: "Server error" });
    }
});

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

// Profile image upload route
app.post('/api/users/:id/upload-profile-image', uploadProfile.single('profileImage'), async (req, res) => {
    const { id } = req.params;

    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        // Update user's profile_image in Firestore
        const userRef = db.collection('users').doc(id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const imagePath = `/uploads/profiles/${req.file.filename}`;
        await userRef.update({ profile_image: imagePath });

        res.json({ success: true, message: 'Profile image uploaded successfully', imagePath });
    } catch (err) {
        console.error('Profile image upload error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// --- USER MANAGEMENT ROUTES ---
app.get('/api/admin/users', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').orderBy('created_at', 'desc').get();
        const users = usersSnapshot.docs.map(doc => {
            const userData = doc.data();
            const createdAt = userData.created_at;
            // Convert Firestore Timestamp to ISO string
            const createdAtISO = createdAt && typeof createdAt.toDate === 'function' 
                ? createdAt.toDate().toISOString()
                : (createdAt?._seconds ? new Date(createdAt._seconds * 1000).toISOString() : null);
            
            return {
                id: doc.id,
                name: userData.name,
                email: userData.email,
                role: userData.role,
                profile_image: userData.profile_image || null,
                created_at: createdAtISO
            };
        });
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
        
        // Convert Firestore Timestamp to ISO string
        const createdAt = userData.created_at;
        const createdAtISO = createdAt && typeof createdAt.toDate === 'function' 
            ? createdAt.toDate().toISOString()
            : (createdAt?._seconds ? new Date(createdAt._seconds * 1000).toISOString() : null);
        
        const lastLogin = userData.last_login;
        const lastLoginISO = lastLogin && typeof lastLogin.toDate === 'function' 
            ? lastLogin.toDate().toISOString()
            : (lastLogin?._seconds ? new Date(lastLogin._seconds * 1000).toISOString() : null);
        
        res.json({
            id: userDoc.id,
            name: userData.name,
            email: userData.email,
            role: userData.role,
            profile_image: userData.profile_image || null,
            created_at: createdAtISO,
            last_login: lastLoginISO
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
            notif_badge_viewed_at: admin.firestore.FieldValue.serverTimestamp(),
            notif_badge_unread: false
        });
        res.json({ success: true, viewed_at: new Date().toISOString(), unread: false });
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
        const unread = userData.notif_badge_unread === true;
        const viewed = !unread;

        res.json({
            viewed,
            unread,
            viewed_at: userData.notif_badge_viewed_at ? (userData.notif_badge_viewed_at.toDate ? userData.notif_badge_viewed_at.toDate().toISOString() : new Date(userData.notif_badge_viewed_at).toISOString()) : null
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

        // Helper function to get capacity from room type
        const getCapacity = (roomType) => {
            if (!roomType) return 1;
            const type = roomType.toLowerCase();
            if (type.includes('single') || type.includes('1 person')) return 1;
            if (type.includes('double') || type.includes('2 person')) return 2;
            if (type.includes('triple') || type.includes('3 person')) return 3;
            if (type.includes('quad') || type.includes('4 person')) return 4;
            return 1; // Default
        };

        for (const dormDoc of dormsSnapshot.docs) {
            const dormData = dormDoc.data();
            // Check if dorm is occupied by counting approved bookings
            const bookingsSnapshot = await db.collection('bookings')
                .where('room_name', '==', dormData.name)
                .where('status', '==', 'Approved')
                .get();

            // Also check for case-insensitive matches (fallback for legacy data)
            let bookingCount = bookingsSnapshot.size;
            if (bookingCount === 0) {
                const caseInsensitiveSnapshot = await db.collection('bookings')
                    .where('status', '==', 'Approved')
                    .get();
                bookingCount = caseInsensitiveSnapshot.docs.filter(doc => 
                    doc.data().room_name.toLowerCase() === dormData.name.toLowerCase()
                ).length;
            }

            const capacity = getCapacity(dormData.room_type);
            const isOccupied = bookingCount >= capacity;

            dorms.push({
                id: dormDoc.id,
                ...dormData,
                is_occupied: isOccupied
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
        console.log('Fetching all bookings...');
        const bookingsSnapshot = await db.collection('bookings').get();
        const bookings = [];

        for (const bookingDoc of bookingsSnapshot.docs) {
            const bookingData = bookingDoc.data();

            // Skip bookings marked as cleared for admin history
            if (bookingData.admin_cleared === true) continue;

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

        // Sort by created_at descending (newest first)
        bookings.sort((a, b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));

        res.json(bookings);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/book', upload.single('receipt'), async (req, res) => {
    try {
        const { user_id, room_name, room_type, start_date, duration, special_request, amount_paid } = req.body;
        
        // Validate start_date is not in the past
        const today = new Date().toISOString().split('T')[0];
        if (start_date < today) {
            return res.status(400).json({ error: "Move-in date cannot be in the past. Please select today or a future date." });
        }

        let receipt_url = null;

        // Upload receipt to Firebase Storage if file exists
        if (req.file) {
            try {
                const bucket = admin.storage().bucket();
                const filename = `receipts/${Date.now()}_${req.file.originalname}`;
                const file = bucket.file(filename);
                
                await file.save(req.file.buffer, {
                    metadata: {
                        contentType: req.file.mimetype
                    }
                });
                
                // Generate public download URL
                receipt_url = `https://storage.googleapis.com/${bucket.name}/${filename}`;
                console.log(`Receipt uploaded to Firebase Storage: ${receipt_url}`);
            } catch (uploadErr) {
                console.error('Error uploading receipt to Firebase Storage:', uploadErr);
                // Fallback: use local file path if Firebase Storage fails
                receipt_url = `/uploads/receipts/${req.file.filename}`;
                console.log(`Using local receipt path as fallback: ${receipt_url}`);
            }
        }

        if (!user_id || !room_name) return res.status(400).json({ error: "Missing required booking data." });

        // Extract duration as integer (remove " Months" suffix if present)
        const durationValue = parseInt(duration) || 1;

        const bookingRef = await db.collection('bookings').add({
            user_id,
            room_name,
            room_type: room_type || 'Standard Room',
            start_date,
            duration: durationValue,
            special_request,
            receipt_url,
            amount_paid: parseFloat(amount_paid) || 0,
            status: 'Pending',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        // Emit booking update immediately to connected clients (real-time) 
        const snapshot = await db.collection('bookings').get();
        const bookings = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('bookings:updated', bookings);

        res.json({ success: true, bookingId: bookingRef.id });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/bookings/user/:userId', async (req, res) => {
    try {
        console.log(`Fetching bookings for user: ${req.params.userId}`);
        const bookingsSnapshot = await db.collection('bookings')
            .where('user_id', '==', req.params.userId)
            .get();

        const bookings = bookingsSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(b => !b.user_hidden)
            .sort((a, b) => (b.created_at?._seconds || 0) - (a.created_at?._seconds || 0));

        console.log(`Found ${bookings.length} bookings for user`);
        res.json(bookings || []);
    } catch (error) {
        console.error('Error fetching user bookings:', error);
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

        // Emit booking update right away for admin/user realtime UI
        const bookingSnapshot = await db.collection('bookings').get();
        const allBookings = bookingSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        io.emit('bookings:updated', allBookings);
        
        // Create notification for user when booking is approved or rejected
        if (status === 'Approved' || status === 'Rejected') {
            try {
                await db.collection('notifications').add({
                    user_id: bookingData.user_id,
                    booking_id: id,
                    room_name: bookingData.room_name,
                    room_type: bookingData.room_type || 'Standard Room',
                    status: status,
                    message: status === 'Approved' 
                        ? `Your booking for ${bookingData.room_name} has been approved!`
                        : `Your booking for ${bookingData.room_name} has been rejected.`,
                    read: false,
                    created_at: admin.firestore.FieldValue.serverTimestamp()
                });

                // Reset the badge-viewed marker so all pages show red dot until viewed again
                await db.collection('users').doc(bookingData.user_id).update({
                    notif_badge_viewed_at: null,
                    notif_badge_unread: true
                });

                console.log(`Notification created for user ${bookingData.user_id} for ${status} booking`);
            } catch (notifErr) {
                console.error('Error creating notification or resetting badge status:', notifErr);
            }
        }
        
        logAction(adminName, `Updated booking status for ${userName} (${bookingData.room_name}) to ${status}`);

        return res.status(200).json({ success: true, message: 'Status updated' });
    } catch (error) {
        console.error('Booking status update error:', error);
        return res.status(500).json({ error: error.message || 'Server error' });
    }
});

app.get('/api/notifications/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const notificationsSnapshot = await db.collection('notifications')
            .where('user_id', '==', userId)
            .get();

        const notifications = notificationsSnapshot.docs
            .map(doc => ({
                id: doc.id,
                ...doc.data()
            }))
            .sort((a, b) => {
                // Sort by created_at timestamp in descending order (most recent first)
                const aTime = a.created_at?._seconds || 0;
                const bTime = b.created_at?._seconds || 0;
                return bTime - aTime;
            })
            .slice(0, 50); // Limit to 50 most recent

        res.json(notifications || []);
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ error: error.message });
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

// --- CLEAR HISTORY ENDPOINTS ---
// Clear all bookings for a specific user
app.delete('/api/bookings/user/:userId/clear', async (req, res) => {
    try {
        const userId = req.params.userId;
        
        // Get all bookings for this user
        const bookingsSnapshot = await db.collection('bookings')
            .where('user_id', '==', userId)
            .get();
        
        let deletedCount = 0;
        
        // Delete each booking
        const batch = db.batch();
        bookingsSnapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
            deletedCount++;
        });
        
        await batch.commit();
        
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true, deletedCount: deletedCount, message: `Cleared ${deletedCount} booking(s) from history` });
    } catch (error) {
        console.error('Error clearing user bookings:', error);
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: error.message });
    }
});

// Clear all bookings (admin only)
app.delete('/api/bookings/clear', async (req, res) => {
    try {
        const adminName = req.query.adminName || 'Admin';
        
        // Get all bookings
        const bookingsSnapshot = await db.collection('bookings').get();
        
        let deletedCount = 0;
        const batch = db.batch();
        bookingsSnapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
            deletedCount++;
        });
        
        await batch.commit();
        
        // Log this action
        logAction(adminName, `Cleared all bookings from system (${deletedCount} record(s))`);
        
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true, deletedCount: deletedCount, message: `Cleared ${deletedCount} booking(s) from system` });
    } catch (error) {
        console.error('Error clearing all bookings:', error);
        res.setHeader('Content-Type', 'application/json');
        res.status(500).json({ error: error.message });
    }
});

// Clear all action logs (admin only)
app.delete('/api/admin/logs/clear', async (req, res) => {
    try {
        const adminName = req.query.adminName || 'Admin';
        
        // Get all action logs
        const logsSnapshot = await db.collection('action_logs').get();
        
        let deletedCount = 0;
        const batch = db.batch();
        logsSnapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
            deletedCount++;
        });
        
        await batch.commit();
        
        res.setHeader('Content-Type', 'application/json');
        res.json({ success: true, deletedCount: deletedCount, message: `Cleared ${deletedCount} log record(s)` });
    } catch (error) {
        console.error('Error clearing action logs:', error);
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