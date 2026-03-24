document.addEventListener('DOMContentLoaded', () => {
    const authForm = document.getElementById('auth-form');
    const authTitle = document.getElementById('auth-title');
    const authSubtitle = document.getElementById('auth-subtitle');
    const submitBtn = document.getElementById('submit-btn');
    const toggleBtn = document.getElementById('toggle-btn');
    const toggleText = document.getElementById('toggle-text');
    const nameField = document.getElementById('name-field');
    const roleContainer = document.getElementById('role-container');
    const inputName = document.getElementById('input-name');

    let isLogin = true;

    // --- 1. TOGGLE FUNCTION ---
    const toggleAuth = () => {
        isLogin = !isLogin;
        authTitle.innerText = isLogin ? "Welcome Back" : "Create Account";
        authSubtitle.innerText = isLogin ? "Please enter your details to login." : "Join DormBook to find your next home.";
        submitBtn.innerText = isLogin ? "Login" : "Register";
        toggleText.innerText = isLogin ? "Don't have an account?" : "Already have an account?";
        toggleBtn.innerText = isLogin ? "Sign Up" : "Login";
        
        nameField?.classList.toggle('hidden', isLogin);
        // Role container stays hidden because we handle admin via master account now
        roleContainer?.classList.add('hidden'); 
        
        if (inputName) inputName.required = !isLogin;
    };

    // --- 2. LISTENERS ---
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleAuth);
    }

    // --- 3. URL DETECTION (FOR "GET STARTED" BUTTON) ---
    // If user comes from welcome.html#signup, trigger the toggle immediately
    if (window.location.hash === '#signup') {
        toggleAuth();
    }

    // --- 4. FORM SUBMISSION ---
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch animate-spin"></i> Processing...';
            
            const formData = new FormData(authForm);
            const data = Object.fromEntries(formData.entries());
            
            // Clean data based on mode
            if (isLogin) {
                delete data.name;
                delete data.role;
            }

            const endpoint = isLogin ? '/api/login' : '/api/register';
            
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });

                const result = await response.json();

                if (response.ok) {
                    const user = result.user;

                    // Persist current user and saved accounts list
                    localStorage.setItem('user', JSON.stringify(user));
                    const savedUsers = JSON.parse(localStorage.getItem('savedUsers') || '[]');
                    const existingIndex = savedUsers.findIndex(s => s.id === user.id || s.email === user.email || s.name === user.name);
                    if (existingIndex === -1) {
                        savedUsers.push(user);
                    } else {
                        savedUsers[existingIndex] = user;
                    }
                    localStorage.setItem('savedUsers', JSON.stringify(savedUsers));
                    
                    // Redirect everyone to index.html (the dashboard handles the rest)
                    window.location.href = 'index.html';
                } else {
                    alert(result.error || "Authentication failed");
                    resetButton();
                }
            } catch (err) {
                console.error("Auth Error:", err);
                alert("Connection lost. Is your server running?");
                resetButton();
            }
        });
    }

    function resetButton() {
        submitBtn.disabled = false;
        submitBtn.innerText = isLogin ? "Login" : "Register";
    }

    // --- GOOGLE SIGN IN ---
    window.signInWithGoogle = () => {
        window.location.href = '/auth/google';
    };
});

// Password Toggle
window.togglePassword = function() {
    const passwordInput = document.getElementById('password-input');
    const eyeIcon = document.getElementById('eye-icon');
    if (passwordInput && eyeIcon) {
        const isPass = passwordInput.type === 'password';
        passwordInput.type = isPass ? 'text' : 'password';
        eyeIcon.className = isPass ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
    }
};