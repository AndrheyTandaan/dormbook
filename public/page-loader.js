(() => {
    const LOADER_ID = 'global-page-loader';

    function ensureLoader() {
        if (document.getElementById(LOADER_ID)) return;

        const overlay = document.createElement('div');
        overlay.id = LOADER_ID;
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'display:none',
            'align-items:center',
            'justify-content:center',
            'background:rgba(255,255,255,0.75)',
            'backdrop-filter:blur(2px)',
            'z-index:99999'
        ].join(';');

        overlay.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
                <div style="width:42px;height:42px;border:4px solid #e5e7eb;border-top-color:#4f46e5;border-radius:9999px;animation:pageLoaderSpin 0.9s linear infinite;"></div>
                <span style="font-family:Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.08em;color:#4b5563;text-transform:uppercase;">Loading</span>
            </div>
        `;

        if (!document.getElementById('page-loader-style')) {
            const style = document.createElement('style');
            style.id = 'page-loader-style';
            style.textContent = '@keyframes pageLoaderSpin { to { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }

        document.body.appendChild(overlay);
    }

    function showLoader() {
        ensureLoader();
        const overlay = document.getElementById(LOADER_ID);
        if (!overlay) return;
        overlay.style.display = 'flex';
        overlay.setAttribute('aria-hidden', 'false');
    }

    function hideLoader() {
        const overlay = document.getElementById(LOADER_ID);
        if (!overlay) return;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
    }

    function shouldHandleLink(link) {
        if (!link) return false;
        if (link.target && link.target.toLowerCase() === '_blank') return false;
        if (link.hasAttribute('download')) return false;
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#')) return false;
        if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return false;
        return true;
    }

    document.addEventListener('DOMContentLoaded', () => {
        ensureLoader();

        document.addEventListener('click', (event) => {
            const link = event.target.closest('a');
            if (!link || !shouldHandleLink(link)) return;
            if (event.defaultPrevented) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            showLoader();
        }, true);

        document.addEventListener('submit', (event) => {
            const form = event.target;
            if (!(form instanceof HTMLFormElement)) return;
            if (event.defaultPrevented) return;
            showLoader();
        }, true);
    });

    window.addEventListener('beforeunload', showLoader);

    window.showPageLoader = showLoader;
    window.hidePageLoader = hideLoader;
})();