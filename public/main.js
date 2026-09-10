let allDorms = []; // Store original data for filtering
let currentBookingData = {}; // Temporary storage for form data before payment
let socket = null;

function setupRealtimeSocket() {
    if (typeof io === 'undefined') {
        console.warn('Socket.IO client is not loaded');
        return;
    }

    socket = io();

    socket.on('connect', () => {
        console.info('Socket connected', socket.id);
    });

    socket.on('connect_error', (err) => {
        console.error('Socket connection error:', err);
    });

    socket.on('dorms:updated', (dorms) => {
        if (!Array.isArray(dorms)) return;
        allDorms = dorms;
        renderDorms(dorms);
    });

    socket.on('bookings:updated', (bookings) => {
        console.info('bookings:updated', bookings);
        // Optional: trigger refresh in booking-specific views
        if (typeof fetchLogs === 'function') {
            fetchLogs(true);
        }
    });

    socket.on('users:updated', (users) => {
        console.info('users:updated', users);
    });

    socket.on('action_logs:updated', (logs) => {
        if (typeof renderLogs === 'function') {
            renderLogs(logs);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    setupRealtimeSocket();
    updateNavbar();
    loadDorms();

    // Event Listeners for Filtering
    document.getElementById('filter-btn').addEventListener('click', applyFilters);

    // Real-time search as you type
    const searchInput = document.getElementById('search-input');
    if (searchInput) searchInput.addEventListener('input', applyFilters);
});

async function loadDorms() {
    try {
        const res = await fetch('/api/dorms');
        allDorms = await res.json();
        renderDorms(allDorms);
    } catch (err) {
        console.error("Failed to load dorms", err);
    }
}

function applyFilters() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();

    let filtered = allDorms.filter(dorm => {
        const matchesName = dorm.name.toLowerCase().includes(searchTerm);
        return matchesName;
    });

    // Sort so that names starting with the search term appear first
    if (searchTerm) {
        filtered.sort((a, b) => {
            const aStarts = a.name.toLowerCase().startsWith(searchTerm);
            const bStarts = b.name.toLowerCase().startsWith(searchTerm);
            if (aStarts && !bStarts) return -1;
            if (!aStarts && bStarts) return 1;
            return 0;
        });
    }

    renderDorms(filtered);
}

function renderDorms(dorms) {
    const container = document.getElementById('dorm-container');
    if (!container) return;
    container.innerHTML = '';

    const user = JSON.parse(localStorage.getItem('user'));

    if (dorms.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-10 text-gray-400 font-medium">No dormitories match your filters.</div>`;
        return;
    }

    dorms.forEach(dorm => {
        const isGoogleLink = dorm.image_url && dorm.image_url.includes('google.com/imgres');
        const imgPath = (!dorm.image_url || isGoogleLink) 
            ? 'https://placehold.co/600x400?text=Invalid+Image+URL' 
            : dorm.image_url;

        let adminActions = '';
        let bookButton = '';

        if (user && user.role === 'admin') {
            adminActions = `
                <div class="flex gap-2 mt-2">
                    <button onclick="openEditModal(${dorm.id})" class="flex-1 border border-indigo-200 text-indigo-600 py-2 rounded-xl text-xs font-bold hover:bg-indigo-50 transition">Edit</button>
                    <button onclick="deleteDorm(${dorm.id})" class="flex-1 border border-red-200 text-red-500 py-2 rounded-xl text-xs font-bold hover:bg-red-50 transition">Delete</button>
                </div>
            `;
        } else {
            bookButton = `<button onclick="openBookingModal('${dorm.name}', '${dorm.description.replace(/'/g, "\\'")}')" class="w-full bg-black text-white py-3 rounded-xl font-bold hover:bg-gray-800 transition">Book Now</button>`;
        }

        container.innerHTML += `
            <div class="bg-white rounded-3xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition">
                <img src="${imgPath}" 
                     onerror="this.src='https://placehold.co/600x400?text=Photo+Unavailable'"
                     class="w-full h-48 object-cover rounded-2xl mb-4 bg-gray-50">
                <div class="flex justify-between items-start mb-2">
                    <h3 class="text-xl font-bold">${dorm.name}</h3>
                    <span class="bg-indigo-50 text-indigo-600 text-xs font-bold px-2 py-1 rounded-lg">${dorm.price}</span>
                </div>
                <p class="text-gray-500 text-sm mb-4 line-clamp-2">${dorm.description}</p>
                <div class="space-y-2">
                    ${user && user.role !== 'admin' ? `<button onclick="openBookingModal('${dorm.name}', '${dorm.description.replace(/'/g, "\\'")}'${dorm.room_type ? `, '${(dorm.room_type).replace(/'/g, "\\'")}` : ', "Standard Room'} )" class="w-full bg-black text-white py-3 rounded-xl font-bold hover:bg-gray-800 transition">Book Now</button>` : bookButton}
                    ${adminActions}
                </div>
            </div>`;
    });
}

function updateNavbar() {
    let user = JSON.parse(localStorage.getItem('user'));
    
    if (!user) {
        // Check session for Google login
        fetch('/api/session-user')
            .then(res => res.json())
            .then(data => {
                if (data.user) {
                    user = data.user;
                    localStorage.setItem('user', JSON.stringify(user));
                    // Update navbar now
                    renderNavbar(user);
                } else {
                    renderNavbar(null);
                }
            })
            .catch(() => renderNavbar(null));
    } else {
        renderNavbar(user);
    }
}

function renderNavbar(user) {
    const authLinks = document.getElementById('auth-links');
    
    if (user && authLinks) {
        const historyLabel = user.role === 'admin' ? 'Action Log' : 'My History';
        const historyPath = user.role === 'admin' ? 'admin_logs.html' : 'bookings_list.html';
        
        const adminLink = user.role === 'admin' 
            ? `<a href="admin.html" class="text-sm font-bold text-red-500">Admin Panel</a>` 
            : '';

        authLinks.innerHTML = `
            <div class="flex items-center gap-4">
                ${adminLink}
                <a href="${historyPath}" class="text-sm font-bold text-indigo-600">${historyLabel}</a>
                <span class="text-gray-700 font-medium text-sm">Hi, ${user.name}</span>
                <button onclick="logout()" class="text-red-500 text-xs font-bold uppercase">Logout</button>
            </div>`;
    }
}

// --- UPDATED EDIT LOGIC (WITH LOGGING) ---
function openEditModal(id) {
    const dorm = allDorms.find(d => d.id === id);
    if (!dorm) return;

    const modal = document.getElementById('booking-modal');
    const formContent = document.getElementById('modal-form-content');
    
    document.getElementById('modal-room-name').innerText = "Edit Dorm Listing";
    const descElement = document.getElementById('modal-room-desc');
    if (descElement) descElement.innerText = "Update the details for " + dorm.name;

    formContent.innerHTML = `
        <form id="edit-dorm-form" class="space-y-4">
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-gray-400 uppercase ml-1">Dorm Name</label>
                <input type="text" name="name" value="${dorm.name}" class="w-full bg-gray-50 border border-gray-100 p-4 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500" required>
            </div>
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-gray-400 uppercase ml-1">Price</label>
                <input type="text" name="price" value="${dorm.price}" class="w-full bg-gray-50 border border-gray-100 p-4 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500" required>
            </div>
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-gray-400 uppercase ml-1">Image URL</label>
                <input type="text" name="image_url" value="${dorm.image_url || ''}" class="w-full bg-gray-50 border border-gray-100 p-4 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500">
            </div>
            <div class="space-y-1">
                <label class="text-[10px] font-bold text-gray-400 uppercase ml-1">Description</label>
                <textarea name="description" class="w-full bg-gray-50 border border-gray-100 p-4 rounded-xl h-24 outline-none focus:ring-2 focus:ring-indigo-500" required>${dorm.description}</textarea>
            </div>
            <div class="flex gap-3 pt-2">
                <button type="button" onclick="closeModal()" class="flex-1 bg-gray-100 text-gray-500 py-4 rounded-xl font-bold">Cancel</button>
                <button type="submit" class="flex-[2] bg-indigo-600 text-white py-4 rounded-xl font-bold shadow-lg">Save Changes</button>
            </div>
        </form>
    `;

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    document.getElementById('edit-dorm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = JSON.parse(localStorage.getItem('user'));
        const formData = new FormData(e.target);
        
        const updatedData = {
            name: formData.get('name'),
            price: formData.get('price'),
            image_url: formData.get('image_url'),
            description: formData.get('description'),
            adminName: user ? user.name : 'Admin' // Send admin name for logging
        };

        try {
            const res = await fetch(`/api/dorms/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedData)
            });

            if (res.ok) {
                alert("Dorm updated successfully!");
                closeModal();
                loadDorms();
            }
        } catch (err) { console.error(err); }
    });
}

// --- UPDATED DELETE LOGIC (WITH LOGGING) ---
async function deleteDorm(id) {
    if (!confirm("Are you sure you want to delete this dorm?")) return;
    
    const user = JSON.parse(localStorage.getItem('user'));
    const adminName = user ? user.name : 'Admin';

    try {
        // We pass adminName as a query parameter so the server knows who deleted it
        const res = await fetch(`/api/dorms/${id}?adminName=${encodeURIComponent(adminName)}`, { 
            method: 'DELETE' 
        });
        
        if (res.ok) {
            alert("Deleted successfully");
            loadDorms();
        } else {
            const errorData = await res.json();
            alert("Error: " + errorData.error);
        }
    } catch (err) { console.error(err); }
}

// ... (Rest of your Booking/Modal/Payment logic remains the same)
function openBookingModal(name, description, roomType) {
    if (!localStorage.getItem('user')) {
        alert("Please login first to book a room.");
        return window.location.href = 'auth.html';
    }

    const modal = document.getElementById('booking-modal');
    if (!modal) {
        console.error('Modal element not found');
        return;
    }

    // Set the current room info for the index.html form handlers
    const selectedDorm = allDorms.find(d => d.name === name);
    if (!selectedDorm) {
        console.error('Dorm not found');
        return;
    }

    // Set global variables that the form handlers expect
    if (typeof currentRoom === 'undefined') window.currentRoom = {};
    currentRoom = {
        name: name,
        description: description,
        room_type: roomType || 'Standard Room',
        price: selectedDorm.price
    };
    
    if (typeof currentRoomPrice === 'undefined') window.currentRoomPrice = 0;
    currentRoomPrice = parseFloat(selectedDorm.price.replace('₱', '').replace(',', '')) || 0;
    
    currentBookingData = {
        user_id: null,
        room_name: name,
        room_type: roomType || 'Standard Room',
        start_date: null,
        duration: null,
        special_request: null
    };
    
    // Update the modal headers
    document.getElementById('modal-room-name').innerText = name;
    const descElement = document.getElementById('modal-room-desc');
    if (descElement) descElement.innerText = description;

    // Clear the form fields
    const form = document.getElementById('modal-booking-form');
    if (form) {
        form.reset();
    }

    // Reset to step 1
    goToStep(1);
    selectPayment('full');

    // Show the modal
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');

    // Set minimum date to today
    const startDateInput = document.querySelector('#modal-booking-form input[name="start_date"]');
    if (startDateInput) {
        const today = new Date();
        const minDate = today.toISOString().split('T')[0];
        startDateInput.setAttribute('min', minDate);
    }
}

function openPaymentModal() {
    // This is not needed with the current flow, kept for compatibility
    goToStep(2);
}

async function handleBookingSubmit() {
    const fileInput = document.getElementById('receipt-upload');
    if (!fileInput.files[0]) {
        alert("Please upload your payment receipt first.");
        return;
    }
    const finalData = new FormData();
    finalData.append('user_id', currentBookingData.user_id);
    finalData.append('room_name', currentBookingData.room_name);
    finalData.append('room_type', currentBookingData.room_type);
    finalData.append('start_date', currentBookingData.start_date);
    finalData.append('duration', currentBookingData.duration);
    finalData.append('special_request', currentBookingData.special_request);
    finalData.append('receipt', fileInput.files[0]);

    const confirmBtn = document.getElementById('confirm-payment-btn');
    confirmBtn.innerText = "Processing...";
    confirmBtn.disabled = true;

    try {
        const res = await fetch('/api/book', { method: 'POST', body: finalData });
        if (res.ok) {
            document.getElementById('payment-modal-content').innerHTML = `
                <div class="text-center py-6">
                    <div class="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center text-2xl mx-auto mb-4">
                        <i class="fa-solid fa-check"></i>
                    </div>
                    <h2 class="text-xl font-black mb-1">Booking Sent!</h2>
                    <p class="text-gray-500 text-xs mb-6">Your request has been submitted.</p>
                    <button onclick="location.reload();" class="bg-black text-white px-8 py-2.5 rounded-xl font-bold text-sm">Done</button>
                </div>
            `;
        } else {
            const errData = await res.json().catch(() => ({}));
            const errMsg = errData.error || errData.message || 'Booking failed.';
            alert(`Booking error: ${errMsg}`);
            confirmBtn.disabled = false;
            confirmBtn.innerText = 'Confirm Payment';
        }
    } catch (err) {
        console.error(err);
        alert("Server error.");
        confirmBtn.disabled = false;
        confirmBtn.innerText = 'Confirm Payment';
    }
}

function closeModal() {
    const modal = document.getElementById('booking-modal');
    const paymentModal = document.getElementById('payment-modal');
    if (modal) modal.classList.add('hidden');
    if (paymentModal) paymentModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
}

function logout() {
    localStorage.removeItem('user');
    // Clear session
    fetch('/auth/logout').then(() => {
        window.location.href = 'index.html';
    });
}