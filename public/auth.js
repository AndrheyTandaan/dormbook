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
    const authError = document.getElementById('auth-error');

    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            authError?.classList.add('hidden');
            authError && (authError.innerText = '');

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

                    localStorage.setItem('user', JSON.stringify(user));
                    const savedUsers = JSON.parse(localStorage.getItem('savedUsers') || '[]');
                    const existingIndex = savedUsers.findIndex(s => s.id === user.id || s.email === user.email || s.name === user.name);
                    if (existingIndex === -1) {
                        savedUsers.push(user);
                    } else {
                        savedUsers[existingIndex] = user;
                    }
                    localStorage.setItem('savedUsers', JSON.stringify(savedUsers));

                    window.location.href = 'index.html';
                } else {
                    authError && (authError.innerText = result.error || 'Authentication failed');
                    authError?.classList.remove('hidden');
                    window.hidePageLoader && window.hidePageLoader();
                }
            } catch (err) {
                console.error('Auth Error:', err);
                authError && (authError.innerText = 'Connection issue, try again.');
                authError?.classList.remove('hidden');
                window.hidePageLoader && window.hidePageLoader();
            } finally {
                resetButton();
            }
        });

        // Forgot Password Modal
        const forgotPasswordBtn = document.getElementById('forgot-password-btn');
        const forgotPasswordModal = document.getElementById('forgot-password-modal');
        const forgotPasswordForm = document.getElementById('forgot-password-form');
        const backToLoginBtn = document.getElementById('back-to-login-btn');
        const forgotError = document.getElementById('forgot-error');
        const forgotSuccess = document.getElementById('forgot-success');

        if (forgotPasswordBtn) {
            forgotPasswordBtn.addEventListener('click', () => {
                forgotPasswordModal.classList.remove('hidden');
            });
        }

        if (backToLoginBtn) {
            backToLoginBtn.addEventListener('click', () => {
                forgotPasswordModal.classList.add('hidden');
                forgotError.classList.add('hidden');
                forgotSuccess.classList.add('hidden');
                forgotPasswordForm.reset();
            });
        }

        if (forgotPasswordForm) {
            forgotPasswordForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                forgotError.classList.add('hidden');
                forgotSuccess.classList.add('hidden');

                const formData = new FormData(forgotPasswordForm);
                const data = Object.fromEntries(formData.entries());

                const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailPattern.test(data.email)) {
                    forgotError.innerText = 'Please enter a valid email address';
                    forgotError.classList.remove('hidden');
                    return;
                }

                try {
                    const response = await fetch('/api/forgot-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });

                    console.log('[Auth] Forgot password response:', response.status, response.ok);
                    const result = await response.json();
                    console.log('[Auth] Result:', result);

                    if (response.ok) {
                        if (result.resetLink) {
                            // Email not configured - show reset link directly
                            forgotSuccess.innerHTML = `
                                <div>
                                    <p>Email not configured. Copy this reset link:</p>
                                    <a href="${result.resetLink}" target="_blank" style="color: #10B981; word-break: break-all;">${result.resetLink}</a>
                                    <p style="font-size: 12px; margin-top: 8px; color: #EF4444;">⚠️ Configure email in .env for production use</p>
                                </div>
                            `;
                        } else {
                            forgotSuccess.innerText = result.message || 'Reset link sent! Check your email.';
                        }
                        forgotSuccess.classList.remove('hidden');
                    } else {
                        forgotError.innerText = result.error || 'Failed to send reset link';
                        forgotError.classList.remove('hidden');
                    }
                } catch (err) {
                    console.error('Forgot Password Error:', err);
                    forgotError.innerText = 'Connection issue, try again.';
                    forgotError.classList.remove('hidden');
                } finally {
                    // Hide the page loader after response
                    window.hidePageLoader && window.hidePageLoader();
                }
            });
        }
    }

    function resetButton() {
        submitBtn.disabled = false;
        submitBtn.innerText = isLogin ? "Login" : "Register";
        window.hidePageLoader && window.hidePageLoader();
    }

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