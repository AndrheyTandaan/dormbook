let currentBookings = [];

/**
 * Retrieves the logged-in admin's name from localStorage.
 */
function getAdminName() {
    try {
        const userData = localStorage.getItem('user');
        if (!userData) return 'Master Admin';
        const user = JSON.parse(userData);
        return user.name || 'Master Admin';
    } catch (e) {
        return 'Master Admin';
    }
}

/**
 * Fetches latest data, calculates dashboard stats, and updates UI.
 */
async function refreshAdminData() {
    try {
        const [dormRes, bookRes] = await Promise.all([
            fetch('/api/dorms'),
            fetch('/api/admin/bookings')
        ]);
        
        const dorms = await dormRes.json();
        currentBookings = await bookRes.json();

        // --- 1. CALCULATE DASHBOARD STATS ---
        let totalRevenue = 0;
        let occupiedCount = 0;

        currentBookings.forEach(b => {
            // Only count active approved bookings (exclude refunded bookings with is_active: false)
            if (b.status === 'Approved' && b.is_active !== false) {
                occupiedCount++;
                // Match booking to dorm to get the price
                const dorm = dorms.find(d => d.id === b.room_id || d.name === b.room_name);
                if (dorm) {
                    totalRevenue += parseFloat(dorm.price) || 0;
                }
            }
        });

        // --- 2. UPDATE STATS UI ---
        // These IDs must exist in your index.html/management.html
        const revenueEl = document.getElementById('total-revenue');
        const occupancyEl = document.getElementById('occupancy-rate');
        const studentCountEl = document.getElementById('student-count');

        if (revenueEl) {
            revenueEl.innerText = `₱${totalRevenue.toLocaleString()}`;
        }

        if (occupancyEl) {
            // Calculate %: (Occupied / Total Dorms) * 100
            const rate = dorms.length > 0 ? ((occupiedCount / dorms.length) * 100).toFixed(0) : 0;
            occupancyEl.innerText = `${rate}%`;
        }

        if (studentCountEl) {
            studentCountEl.innerText = occupiedCount;
        }

        // --- 3. RENDER TABLES ---
        renderBookings(); 
        renderDorms(dorms); 
    } catch (err) { 
        console.error("Data Sync Error:", err); 
    }
}

/**
 * Renders the Booking Management table (Requests).
 */
function renderBookings() {
    const bookList = document.getElementById('admin-booking-list');
    if (!bookList) return;

    if (!currentBookings.length) {
        bookList.innerHTML = '<tr><td colspan="4" class="p-10 text-center text-gray-400 italic font-medium tracking-tight">No active requests found.</td></tr>';
        return;
    }

    bookList.innerHTML = currentBookings.map(b => {
        let statusBadge = b.status === 'Approved' 
            ? `<span class="text-green-600 font-black text-[10px] uppercase tracking-widest"><i class="fa-solid fa-check mr-1"></i> Approved</span>`
            : b.status === 'Rejected'
            ? `<span class="text-red-500 font-black text-[10px] uppercase tracking-widest"><i class="fa-solid fa-xmark mr-1"></i> Rejected</span>`
            : `<span class="text-orange-500 font-black text-[10px] uppercase tracking-widest animate-pulse"><i class="fa-solid fa-clock mr-1"></i> Pending</span>`;

        return `
            <tr class="hover:bg-gray-50/50 transition">
                <td class="p-5">
                    <p class="font-black text-gray-800 uppercase tracking-tighter text-sm">${b.user_name || 'Student'}</p>
                    <p class="text-[9px] text-gray-400 font-bold uppercase tracking-widest">Ref: #${b.id}</p>
                </td>
                <td class="p-5 font-bold text-gray-600">${b.room_name || 'Room'}</td>
                <td class="p-5">${statusBadge}</td>
                <td class="p-5 text-center space-x-2">
                    <button onclick="openDetailView(${b.id})" class="text-indigo-600 hover:bg-indigo-50 p-2.5 rounded-xl transition">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                    <button onclick="deleteBooking(${b.id})" class="text-red-400 hover:bg-red-50 p-2.5 rounded-xl transition">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Renders the Room Status Tracker (Inventory Table).
 */
function renderDorms(dorms) {
    const inventoryList = document.getElementById('management-inventory-list');
    if (!inventoryList) return;

    inventoryList.innerHTML = dorms.map(dorm => {
        // Find active approved booking (exclude inactive/refunded bookings)
        const activeBooking = currentBookings.find(b => b.room_id === dorm.id && b.status === 'Approved' && b.is_active !== false);
        
        const isOccupied = !!activeBooking;
        const statusClass = isOccupied ? 'status-occupied' : 'status-available';
        const statusText = isOccupied ? 'Occupied' : 'Available';
        const residentName = isOccupied ? activeBooking.user_name : '<span class="italic text-gray-300">Vacant</span>';

        return `
            <tr class="hover:bg-gray-50/30 transition">
                <td class="p-5">
                    <p class="font-black text-gray-800 uppercase tracking-tighter">${dorm.name}</p>
                    <p class="text-[9px] text-gray-400 font-bold uppercase tracking-widest">${dorm.location || 'Campus Area'}</p>
                </td>
                <td class="p-5 font-black text-gray-600">₱${Number(dorm.price).toLocaleString()}</td>
                <td class="p-5 font-bold text-indigo-900">${residentName}</td>
                <td class="p-5">
                    <span class="status-pill ${statusClass}">${statusText}</span>
                </td>
                <td class="p-5 text-right">
                    <button onclick="deleteDorm(${dorm.id})" class="text-gray-300 hover:text-red-500 transition px-3">
                        <i class="fa-solid fa-trash-can text-xs"></i>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

/**
 * Modal & Status Actions
 */
function openDetailView(id) {
    const booking = currentBookings.find(b => b.id === id);
    if (!booking) return;

    const modal = document.getElementById('receipt-modal');
    
    modal.innerHTML = `
        <div class="bg-white rounded-[3rem] p-10 max-w-lg w-full shadow-2xl relative overflow-hidden">
            <button onclick="closeReceiptModal()" class="absolute top-6 right-6 text-gray-400 hover:text-black transition">
                <i class="fa-solid fa-circle-xmark text-2xl"></i>
            </button>
            <h2 class="text-2xl font-black mb-6 uppercase tracking-tighter">Review Application</h2>
            
            <div class="space-y-4 mb-8">
                <div class="flex justify-between border-b border-gray-50 pb-2">
                    <span class="text-[10px] font-black uppercase text-gray-400">Student</span>
                    <span class="font-bold text-sm">${booking.user_name}</span>
                </div>
                <div class="flex justify-between border-b border-gray-50 pb-2">
                    <span class="text-[10px] font-black uppercase text-gray-400">Stay Duration</span>
                    <span class="font-bold text-sm">${booking.duration} Months</span>
                </div>
            </div>

            <div class="bg-gray-100 rounded-2xl h-64 mb-6 overflow-hidden">
                <img src="${booking.receipt_url || 'https://placehold.co/400x600?text=No+Receipt'}" class="w-full h-full object-cover">
            </div>

            <div class="flex gap-4">
                ${booking.status === 'Pending' ? `
                    <button onclick="updateStatus(${booking.id}, 'Approved')" class="flex-1 bg-green-600 text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest hover:bg-green-700 transition">Approve</button>
                    <button onclick="updateStatus(${booking.id}, 'Rejected')" class="flex-1 bg-red-500 text-white py-4 rounded-2xl font-black uppercase text-xs tracking-widest hover:bg-red-600 transition">Reject</button>
                ` : `
                    <div class="w-full text-center py-4 bg-gray-50 rounded-2xl font-black text-gray-400 uppercase text-[10px]">Action Recorded: ${booking.status}</div>
                `}
            </div>
        </div>
    `;
    modal.classList.remove('hidden');
}

async function updateStatus(id, status) {
    try {
        window.showPageLoader();
        const res = await fetch(`/api/bookings/${id}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, adminName: getAdminName() })
        });
        
        if (res.ok) {
            closeReceiptModal();
            refreshAdminData();
            window.hidePageLoader();
        } else {
            const error = await res.json();
            window.hidePageLoader();
            alert("Error: " + (error.error || "Failed to update status"));
        }
    } catch (err) { 
        window.hidePageLoader();
        console.error("Update error:", err);
        alert("Error: " + err.message);
    }
}

async function deleteBooking(id) {
    if(!confirm("Remove this booking record?")) return;
    try {
        const res = await fetch(`/api/bookings/${id}?adminName=${encodeURIComponent(getAdminName())}`, { 
            method: 'DELETE' 
        });
        if (res.ok) {
            refreshAdminData();
        } else {
            const error = await res.json();
            alert("Error: " + (error.error || "Failed to delete booking"));
        }
    } catch (err) { 
        console.error("Delete error:", err);
        alert("Error: " + err.message);
    }
}

async function deleteDorm(id) {
    if (!confirm("Delete this property? This will remove it from student search.")) return;
    try {
        const res = await fetch(`/api/dorms/${id}?adminName=${encodeURIComponent(getAdminName())}`, { 
            method: 'DELETE' 
        });
        if (res.ok) {
            refreshAdminData();
        } else {
            const error = await res.json();
            alert("Error: " + (error.error || "Failed to delete dorm"));
        }
    } catch (err) { 
        console.error("Delete error:", err);
        alert("Error: " + err.message);
    }
}

function closeReceiptModal() { 
    document.getElementById('receipt-modal').classList.add('hidden'); 
}

// Initial Load
refreshAdminData();