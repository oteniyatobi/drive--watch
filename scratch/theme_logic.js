// Theme Management
function toggleTheme() {
    const isLight = document.getElementById('theme-toggle').checked;
    const theme = isLight ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dw-theme', theme);
    
    // Update map if it exists
    if (typeof updateMapTheme === 'function') {
        updateMapTheme(theme);
    }
    
    logEvent(`SYS: Theme switched to ${theme.toUpperCase()} mode.`, 't-info');
}

function syncThemeUI() {
    const theme = localStorage.getItem('dw-theme') || 'dark';
    const toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.checked = (theme === 'light');
    document.documentElement.setAttribute('data-theme', theme);
}

// Hook into Profile render
function renderProfile() {
    const user = auth.currentUser;
    if (!user || !currentUserData) return;

    document.getElementById('prof-name').innerText = currentUserData.driverName || '---';
    document.getElementById('prof-email').innerText = user.email || '---';
    document.getElementById('prof-sex').innerText = currentUserData.gender || '---';
    document.getElementById('prof-phone').innerText = currentUserData.phoneNumber || '---';
    document.getElementById('prof-ec').innerText = currentUserData.emergencyContact?.name 
        ? `${currentUserData.emergencyContact.name} (${currentUserData.emergencyContact.phone})`
        : '---';

    const initials = (currentUserData.driverName || '?').split(' ').map(n => n[0]).join('').toUpperCase();
    document.getElementById('profile-avatar-initials').innerText = initials.substring(0, 2);
    document.getElementById('profile-display-name').innerText = currentUserData.driverName.toUpperCase();
    
    syncThemeUI(); // Ensure toggle matches saved state
}
