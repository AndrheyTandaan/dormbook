function toggleSidebar() {
    document.getElementById('sidebar-drawer').classList.toggle('translate-x-full');
    document.getElementById('sidebar-overlay').classList.toggle('active');
}

function toggleDropdown(e, id) {
    e.stopPropagation();
    const target = document.getElementById(id);
    document.querySelectorAll('.dropdown-menu').forEach(m => {
        if (m !== target) m.classList.remove('show');
    });
    target.classList.toggle('show');
}

window.onclick = () => {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('show'));
};