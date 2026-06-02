// ============================================
// SUPABASE CONFIGURATION
// ============================================

const SUPABASE_URL = 'https://aczqcdgjvwjtalvrzhcz.supabase.co';
// NOTE: Replace this with your actual anon key from Supabase Dashboard > Settings > API > anon public
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFjenFjZGdqdndqdGFsdnJ6aGN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg3NDQ5NzMsImV4cCI6MjA4NDMyMDk3M30.O8OiZb2bsnpEP6T64hIDfKcJ12dc_CXsOInZvzL_J7o';

// Current logged in player
let currentPlayer = null;

// Supabase API helper
async function supabaseRequest(endpoint, method = 'GET', body = null) {
    // Check if Supabase is configured
    if (SUPABASE_ANON_KEY === 'REPLACE_THIS_WITH_YOUR_ACTUAL_KEY') {
        throw new Error('Supabase not configured. Please set your anon key.');
    }
    
    const options = {
        method,
        headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'return=representation' : undefined
        }
    };
    if (body) options.body = JSON.stringify(body);
    
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, options);
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Network error' }));
            throw new Error(error.message || 'Request failed');
        }
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    } catch (error) {
        console.error('Supabase error:', error);
        throw error;
    }
}

// ============================================
// PLAYER AUTHENTICATION & PROFILE
// ============================================

// Check if username exists
async function checkUsernameExists(username) {
    try {
        const data = await supabaseRequest(`players?username=eq.${encodeURIComponent(username)}&select=id`);
        return data && data.length > 0;
    } catch (error) {
        console.error('Error checking username:', error);
        return false;
    }
}

// Register new player
async function registerPlayer(username, password) {
    try {
        // Check if username already exists
        const exists = await checkUsernameExists(username);
        if (exists) {
            throw new Error('Username already taken');
        }
        
        // Simple hash for password (in production, use proper hashing on server)
        const passwordHash = await simpleHash(password);
        
        const playerData = {
            username: username,
            password_hash: passwordHash,
            avatar_config: currentAvatar || generateRandomAvatar(),
            games_played: 0,
            games_won: 0,
            total_score: 0,
            highest_score: 0
        };
        
        const data = await supabaseRequest('players', 'POST', playerData);
        
        if (data && data.length > 0) {
            currentPlayer = data[0];
            savePlayerSession(currentPlayer);
            return { success: true, player: currentPlayer };
        }
        throw new Error('Registration failed');
    } catch (error) {
        console.error('Registration error:', error);
        return { success: false, error: error.message };
    }
}

// Login player
async function loginPlayer(username, password) {
    try {
        const passwordHash = await simpleHash(password);
        const data = await supabaseRequest(
            `players?username=eq.${encodeURIComponent(username)}&password_hash=eq.${encodeURIComponent(passwordHash)}&select=*`
        );
        
        if (data && data.length > 0) {
            currentPlayer = data[0];
            
            // Update last_seen
            await supabaseRequest(
                `players?id=eq.${currentPlayer.id}`,
                'PATCH',
                { last_seen: new Date().toISOString() }
            );
            
            // Load avatar from profile
            if (currentPlayer.avatar_config) {
                currentAvatar = currentPlayer.avatar_config;
                saveAvatarToStorage();
            }
            
            savePlayerSession(currentPlayer);
            return { success: true, player: currentPlayer };
        }
        throw new Error('Invalid username or password');
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: error.message };
    }
}

// Logout player
function logoutPlayer() {
    currentPlayer = null;
    localStorage.removeItem('playerSession');
    updateAuthUI();
}

// Save player session to localStorage
function savePlayerSession(player) {
    localStorage.setItem('playerSession', JSON.stringify({
        id: player.id,
        username: player.username,
        avatar_config: player.avatar_config
    }));
}

// Load player session from localStorage
async function loadPlayerSession() {
    const saved = localStorage.getItem('playerSession');
    if (saved) {
        try {
            const session = JSON.parse(saved);
            // Verify session is still valid by fetching fresh data
            const data = await supabaseRequest(`players?id=eq.${session.id}&select=*`);
            if (data && data.length > 0) {
                currentPlayer = data[0];
                if (currentPlayer.avatar_config) {
                    currentAvatar = currentPlayer.avatar_config;
                }
                return true;
            }
        } catch (e) {
            console.error('Session load error:', e);
        }
    }
    return false;
}

// Update player profile (avatar, etc.)
async function updatePlayerProfile(updates) {
    if (!currentPlayer) return { success: false, error: 'Not logged in' };
    
    try {
        await supabaseRequest(
            `players?id=eq.${currentPlayer.id}`,
            'PATCH',
            updates
        );
        
        // Update local player object
        Object.assign(currentPlayer, updates);
        savePlayerSession(currentPlayer);
        
        return { success: true };
    } catch (error) {
        console.error('Profile update error:', error);
        return { success: false, error: error.message };
    }
}

// Save avatar to Supabase
async function saveAvatarToSupabase() {
    if (!currentPlayer) return;
    
    await updatePlayerProfile({ avatar_config: currentAvatar });
}

// Update player stats after game
async function updatePlayerStats(score, won, playersCount, position = null) {
    if (!currentPlayer) return;
    
    try {
        const updates = {
            games_played: currentPlayer.games_played + 1,
            total_score: currentPlayer.total_score + score,
            last_seen: new Date().toISOString()
        };
        
        if (won) {
            updates.games_won = currentPlayer.games_won + 1;
        }
        
        if (score > currentPlayer.highest_score) {
            updates.highest_score = score;
        }
        
        await updatePlayerProfile(updates);
        
        // Also save to game history
        await supabaseRequest('game_history', 'POST', {
            player_id: currentPlayer.id,
            room_code: currentRoomCode || 'solo',
            score: score,
            position: position || (won ? 1 : null),
            players_count: playersCount
        });
        
        // Update local currentPlayer object
        currentPlayer.games_played = updates.games_played;
        currentPlayer.total_score = updates.total_score;
        if (won) currentPlayer.games_won = updates.games_won;
        if (score > currentPlayer.highest_score) currentPlayer.highest_score = score;
        
        // Refresh auth UI to show updated stats
        updateAuthUI();
        
    } catch (error) {
        console.error('Stats update error:', error);
    }
}

// Get global leaderboard
async function getGlobalLeaderboard(limit = 10) {
    try {
        const data = await supabaseRequest(
            `players?select=username,total_score,games_played,games_won,avatar_config&order=total_score.desc&limit=${limit}`
        );
        return data || [];
    } catch (error) {
        console.error('Leaderboard error:', error);
        return [];
    }
}

// Simple hash function (for demo - use bcrypt in production)
async function simpleHash(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str + 'quiz_game_salt_2024');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Update UI based on auth state
function updateAuthUI() {
    const authSection = document.getElementById('authSection');
    const profileSection = document.getElementById('profileSection');
    const usernameDisplay = document.getElementById('usernameDisplay');
    const profileAvatar = document.getElementById('profileAvatar');
    const playerStatsDisplay = document.getElementById('playerStatsDisplay');
    
    if (currentPlayer) {
        if (authSection) authSection.style.display = 'none';
        if (profileSection) profileSection.style.display = 'flex';
        if (usernameDisplay) usernameDisplay.textContent = currentPlayer.username;
        if (profileAvatar && currentPlayer.avatar_config) {
            profileAvatar.src = generateAvatarUrl(currentPlayer.avatar_config);
        }
        if (playerStatsDisplay) {
            playerStatsDisplay.innerHTML = `
                <span>🎮 ${currentPlayer.games_played}</span>
                <span>🏆 ${currentPlayer.games_won}</span>
                <span>⭐ ${currentPlayer.total_score}</span>
            `;
        }
        
        // Update home screen stats strip
        const strip = document.getElementById('homeStatsStrip');
        if (strip) {
            strip.style.display = 'flex';
            const s = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
            s('homeStatGames', currentPlayer.games_played || 0);
            s('homeStatWins', currentPlayer.games_won || 0);
            s('homeStatScore', currentPlayer.total_score || 0);
            s('homeStatBest', currentPlayer.highest_score || 0);
        }
        
        // Update welcome name
        const welcomeName = document.getElementById('welcomeName');
        if (welcomeName) welcomeName.textContent = currentPlayer.username;
        
        // Pre-fill name fields
        const createName = document.getElementById('createName');
        const joinName = document.getElementById('joinName');
        if (createName) createName.value = currentPlayer.username;
        if (joinName) joinName.value = currentPlayer.username;
    } else {
        if (authSection) authSection.style.display = 'flex';
        if (profileSection) profileSection.style.display = 'none';
        const strip = document.getElementById('homeStatsStrip');
        if (strip) strip.style.display = 'none';
    }
}

// Show auth tab (login/register)
function showAuthTab(tab) {
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const tabs = document.querySelectorAll('.auth-tab');
    
    tabs.forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    if (tab === 'login') {
        if (loginForm) loginForm.style.display = 'flex';
        if (registerForm) registerForm.style.display = 'none';
    } else {
        if (loginForm) loginForm.style.display = 'none';
        if (registerForm) registerForm.style.display = 'flex';
    }
    
    // Clear error
    const authError = document.getElementById('authError');
    if (authError) authError.textContent = '';
}

// Handle login
async function handleLogin() {
    const username = document.getElementById('loginUsername')?.value.trim();
    const password = document.getElementById('loginPassword')?.value;
    const authError = document.getElementById('authError');
    
    if (!username || !password) {
        if (authError) authError.textContent = 'Please fill in all fields';
        return;
    }
    
    if (authError) authError.textContent = 'Logging in...';
    
    const result = await loginPlayer(username, password);
    
    if (result.success) {
        if (authError) authError.textContent = '';
        updateAuthUI();
        updateAllAvatarDisplays();
    } else {
        if (authError) authError.textContent = result.error || 'Login failed';
    }
}

// Handle register
async function handleRegister() {
    const username = document.getElementById('registerUsername')?.value.trim();
    const password = document.getElementById('registerPassword')?.value;
    const passwordConfirm = document.getElementById('registerPasswordConfirm')?.value;
    const authError = document.getElementById('authError');
    
    if (!username || !password || !passwordConfirm) {
        if (authError) authError.textContent = 'Please fill in all fields';
        return;
    }
    
    if (username.length < 3) {
        if (authError) authError.textContent = 'Username must be at least 3 characters';
        return;
    }
    
    if (password.length < 4) {
        if (authError) authError.textContent = 'Password must be at least 4 characters';
        return;
    }
    
    if (password !== passwordConfirm) {
        if (authError) authError.textContent = 'Passwords do not match';
        return;
    }
    
    if (authError) authError.textContent = 'Creating account...';
    
    const result = await registerPlayer(username, password);
    
    if (result.success) {
        if (authError) authError.textContent = '';
        updateAuthUI();
        updateAllAvatarDisplays();
    } else {
        if (authError) authError.textContent = result.error || 'Registration failed';
    }
}

// Show global leaderboard
async function showGlobalLeaderboard() {
    let leaderboard = [];
    let errorMsg = null;
    
    try {
        leaderboard = await getGlobalLeaderboard(10);
    } catch (error) {
        errorMsg = error.message;
    }
    
    let html = `
        <div class="global-leaderboard-overlay" onclick="closeGlobalLeaderboard(event)">
            <div class="global-leaderboard-modal" onclick="event.stopPropagation()">
                <h2>🏆 Global Leaderboard</h2>
                <div class="global-leaderboard-list">
    `;
    
    if (errorMsg) {
        html += `<p class="no-data">⚠️ ${errorMsg}</p>`;
    } else if (leaderboard.length === 0) {
        html += '<p class="no-data">No players yet. Be the first!</p>';
    } else {
        leaderboard.forEach((player, idx) => {
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`;
            const avatarUrl = player.avatar_config ? generateAvatarUrl(player.avatar_config) : generateAvatarUrlFromName(player.username);
            
            html += `
                <div class="leaderboard-row ${idx < 3 ? 'top-three' : ''}">
                    <span class="lb-rank">${medal}</span>
                    <img src="${avatarUrl}" alt="${player.username}" class="lb-avatar">
                    <span class="lb-name">${player.username}</span>
                    <span class="lb-score">${player.total_score} pts</span>
                    <span class="lb-stats">${player.games_won}W / ${player.games_played}G</span>
                </div>
            `;
        });
    }
    
    html += `
                </div>
                <button class="btn" onclick="closeGlobalLeaderboard()">Close</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
}

function closeGlobalLeaderboard(event) {
    const overlay = document.querySelector('.global-leaderboard-overlay');
    if (overlay) overlay.remove();
}

// ============================================
// DICEBEAR AVATAR SYSTEM
// ============================================

const avatarOptions = {
    skinColor: ['9e5622', 'f5d6c3', 'f2c7a5', 'd4a574', '8d5524', '6d4228', 'ffdbac', 'e8beac'],
    hair: ['short01', 'short02', 'short03', 'short04', 'short05', 'short06', 'short07', 'short08', 'short09', 'short10', 'short11', 'short12', 'short13', 'short14', 'short15', 'short16', 'long01', 'long02', 'long03', 'long04', 'long05', 'long06', 'long07', 'long08', 'long09', 'long10', 'long11', 'long12', 'long13', 'long14', 'long15', 'long16', 'long17', 'long18', 'long19', 'long20', 'long21'],
    hairColor: ['0e0e0e', '3d2314', '5a3825', '85461e', 'a55728', 'b7652c', 'cb8442', 'd9a84a', 'e8c888', 'f4d7a4', 'b55239', 'c93305', '562b00', '796a45', '9a8b6f'],
    eyes: ['variant01', 'variant02', 'variant03', 'variant04', 'variant05', 'variant06', 'variant07', 'variant08', 'variant09', 'variant10', 'variant11', 'variant12', 'variant13', 'variant14', 'variant15', 'variant16', 'variant17', 'variant18', 'variant19', 'variant20', 'variant21', 'variant22', 'variant23', 'variant24', 'variant25', 'variant26'],
    eyebrows: ['variant01', 'variant02', 'variant03', 'variant04', 'variant05', 'variant06', 'variant07', 'variant08', 'variant09', 'variant10', 'variant11', 'variant12', 'variant13', 'variant14', 'variant15'],
    mouth: ['variant01', 'variant02', 'variant03', 'variant04', 'variant05', 'variant06', 'variant07', 'variant08', 'variant09', 'variant10', 'variant11', 'variant12', 'variant13', 'variant14', 'variant15', 'variant16', 'variant17', 'variant18', 'variant19', 'variant20', 'variant21', 'variant22', 'variant23', 'variant24', 'variant25', 'variant26', 'variant27', 'variant28', 'variant29', 'variant30'],
    glasses: ['', 'variant01', 'variant02', 'variant03', 'variant04', 'variant05'],
    earrings: ['', 'variant01', 'variant02', 'variant03', 'variant04', 'variant05', 'variant06'],
    features: ['', 'blush', 'freckles', 'birthmark']
};

const categoryConfig = {
    skinColor: { icon: '🎨', label: { en: 'Skin', fr: 'Peau' }, type: 'color' },
    hair: { icon: '💇', label: { en: 'Hair', fr: 'Cheveux' }, type: 'option' },
    hairColor: { icon: '🎨', label: { en: 'Hair Color', fr: 'Couleur' }, type: 'color' },
    eyes: { icon: '👁️', label: { en: 'Eyes', fr: 'Yeux' }, type: 'option' },
    eyebrows: { icon: '🤨', label: { en: 'Brows', fr: 'Sourcils' }, type: 'option' },
    mouth: { icon: '👄', label: { en: 'Mouth', fr: 'Bouche' }, type: 'option' },
    glasses: { icon: '👓', label: { en: 'Glasses', fr: 'Lunettes' }, type: 'option' },
    earrings: { icon: '💎', label: { en: 'Earrings', fr: 'Boucles' }, type: 'option' },
    features: { icon: '✨', label: { en: 'Features', fr: 'Traits' }, type: 'option' }
};

const skinColorHex = {
    '9e5622': '#9e5622', 'f5d6c3': '#f5d6c3', 'f2c7a5': '#f2c7a5', 'd4a574': '#d4a574',
    '8d5524': '#8d5524', '6d4228': '#6d4228', 'ffdbac': '#ffdbac', 'e8beac': '#e8beac'
};

const hairColorHex = {
    '0e0e0e': '#0e0e0e', '3d2314': '#3d2314', '5a3825': '#5a3825', '85461e': '#85461e',
    'a55728': '#a55728', 'b7652c': '#b7652c', 'cb8442': '#cb8442', 'd9a84a': '#d9a84a',
    'e8c888': '#e8c888', 'f4d7a4': '#f4d7a4', 'b55239': '#b55239', 'c93305': '#c93305',
    '562b00': '#562b00', '796a45': '#796a45', '9a8b6f': '#9a8b6f'
};

let currentAvatar = loadAvatarFromStorage() || generateRandomAvatar();
let currentCategory = 'hair';

function loadAvatarFromStorage() {
    const saved = localStorage.getItem('playerAvatar');
    if (saved) { try { return JSON.parse(saved); } catch (e) { return null; } }
    return null;
}

function saveAvatarToStorage() {
    localStorage.setItem('playerAvatar', JSON.stringify(currentAvatar));
    // Also save to Supabase if logged in
    if (currentPlayer) {
        saveAvatarToSupabase();
    }
}

function generateRandomAvatar() {
    return {
        skinColor: avatarOptions.skinColor[Math.floor(Math.random() * avatarOptions.skinColor.length)],
        hair: avatarOptions.hair[Math.floor(Math.random() * avatarOptions.hair.length)],
        hairColor: avatarOptions.hairColor[Math.floor(Math.random() * avatarOptions.hairColor.length)],
        eyes: avatarOptions.eyes[Math.floor(Math.random() * avatarOptions.eyes.length)],
        eyebrows: avatarOptions.eyebrows[Math.floor(Math.random() * avatarOptions.eyebrows.length)],
        mouth: avatarOptions.mouth[Math.floor(Math.random() * avatarOptions.mouth.length)],
        glasses: avatarOptions.glasses[Math.floor(Math.random() * 3) === 0 ? Math.floor(Math.random() * avatarOptions.glasses.length) : 0],
        earrings: avatarOptions.earrings[Math.floor(Math.random() * 4) === 0 ? Math.floor(Math.random() * avatarOptions.earrings.length) : 0],
        features: avatarOptions.features[Math.floor(Math.random() * 3) === 0 ? Math.floor(Math.random() * avatarOptions.features.length) : 0]
    };
}

function generateAvatarUrl(options) {
    const opts = options || currentAvatar;
    const params = new URLSearchParams();
    if (opts.skinColor) params.append('skinColor', opts.skinColor);
    if (opts.hair) params.append('hair', opts.hair);
    if (opts.hairColor) params.append('hairColor', opts.hairColor);
    if (opts.eyes) params.append('eyes', opts.eyes);
    if (opts.eyebrows) params.append('eyebrows', opts.eyebrows);
    if (opts.mouth) params.append('mouth', opts.mouth);
    if (opts.glasses) { params.append('glasses', opts.glasses); params.append('glassesProbability', '100'); }
    if (opts.earrings) { params.append('earrings', opts.earrings); params.append('earringsProbability', '100'); }
    if (opts.features) { params.append('features', opts.features); params.append('featuresProbability', '100'); }
    return 'https://api.dicebear.com/7.x/adventurer/svg?' + params.toString();
}

function generateAvatarUrlFromName(name) {
    const seed = name || 'Player';
    return `https://api.dicebear.com/7.x/adventurer/svg?seed=${encodeURIComponent(seed)}`;
}

function updateAllAvatarDisplays() {
    const url = generateAvatarUrl(currentAvatar);
    const homeImg = document.getElementById('homeAvatarImg');
    const dressingImg = document.getElementById('dressingAvatarImg');
    if (homeImg) homeImg.src = url;
    if (dressingImg) dressingImg.src = url;
}

function randomizeAvatar() {
    currentAvatar = generateRandomAvatar();
    updateAllAvatarDisplays();
    showAvatarReaction();
}

function showAvatarReaction() {
    const reactions = ['😍', '🤩', '✨', '🎉', '💫', '🌟', '😎', '🔥'];
    const reaction = reactions[Math.floor(Math.random() * reactions.length)];
    const el = document.getElementById('avatarReaction');
    if (el) {
        el.textContent = reaction;
        el.classList.remove('show');
        void el.offsetWidth;
        el.classList.add('show');
        setTimeout(() => el.classList.remove('show'), 1500);
    }
}

function saveAvatar() {
    saveAvatarToStorage();
    showAvatarReaction();
    closeDressingRoom();
}

function selectAvatarOption(category, value) {
    currentAvatar[category] = value;
    updateAllAvatarDisplays();
    renderAvatarOptions();
    showAvatarReaction();
}

function openDressingRoom() {
    showScreen('dressingRoomScreen');
    updateAllAvatarDisplays();
    renderCategoryTabs();
    renderAvatarOptions();
}

function closeDressingRoom() {
    showHome();
}

function renderCategoryTabs() {
    const container = document.getElementById('categoryTabs');
    if (!container) return;
    
    container.innerHTML = Object.entries(categoryConfig).map(([key, config]) => `
        <div class="avatar-category-tab ${currentCategory === key ? 'active' : ''}" onclick="selectCategory('${key}')">
            <span class="tab-icon">${config.icon}</span>
            <span class="tab-label">${config.label[selectedLanguage] || config.label.en}</span>
        </div>
    `).join('');
}

function selectCategory(category) {
    currentCategory = category;
    renderCategoryTabs();
    renderAvatarOptions();
}

function renderAvatarOptions() {
    const container = document.getElementById('avatarOptionsContainer');
    if (!container) return;
    
    const config = categoryConfig[currentCategory];
    const options = avatarOptions[currentCategory];
    const isColor = config.type === 'color';
    
    let html = '';
    
    if (isColor) {
        const colorMap = currentCategory === 'skinColor' ? skinColorHex : hairColorHex;
        html += `<div class="avatar-color-grid">`;
        options.forEach(opt => {
            const selected = currentAvatar[currentCategory] === opt;
            const hexColor = colorMap[opt] || '#' + opt;
            html += `<button class="avatar-color-btn ${selected ? 'selected' : ''}" 
                style="background-color: ${hexColor};" 
                onclick="selectAvatarOption('${currentCategory}', '${opt}')"
                title="${opt}">
            </button>`;
        });
        html += `</div>`;
    } else {
        html += `<div class="avatar-options-grid">`;
        options.forEach((opt, idx) => {
            const selected = currentAvatar[currentCategory] === opt;
            
            // Generate a preview avatar with this option
            const previewAvatar = { ...currentAvatar };
            previewAvatar[currentCategory] = opt;
            const previewUrl = generateAvatarUrl(previewAvatar);
            
            // Special label for empty option
            const isEmpty = opt === '';
            
            html += `<button class="avatar-option-btn ${selected ? 'selected' : ''}" 
                onclick="selectAvatarOption('${currentCategory}', '${opt}')">
                ${isEmpty ? '<span style="font-size:20px">❌</span>' : `<img src="${previewUrl}" alt="${opt || 'None'}" loading="lazy">`}
            </button>`;
        });
        html += `</div>`;
    }
    
    container.innerHTML = html;
}

// ============================================
// LANDING PAGE
// ============================================

// VERSION CHECK - Remove after debugging


// Initialize game on page load
document.addEventListener('DOMContentLoaded', async function() {
    // Initialize avatar display
    setTimeout(() => {
        if (!currentAvatar) currentAvatar = generateRandomAvatar();
        updateAllAvatarDisplays();
    }, 100);
    
    // Try to load saved session
    try {
        await loadPlayerSession();
        updateAuthUI();
    } catch (e) {
        console.log('No saved session');
    }
});

// ============================================
// TRANSLATIONS
// ============================================

const translations = {
    en: {
        title: "🎯 Questions for a Champion",
        settings: "Settings",
        selectLanguage: "Select Language:",
        selectTheme: "Select Theme:",
        done: "Done",
        soloMode: "🎮 Solo Mode",
        multiplayerMode: "👥 Multiplayer Mode",
        createRoom: "Create Room",
        joinRoom: "Join Room",
        enterRoomCode: "Enter Room Code (e.g., ABCD)",
        yourName: "Your Name",
        createAndJoin: "Create & Join",
        back: "Back",
        roomCode: "Room Code",
        continue: "Continue",
        // Avatar translations
        avatarStudio: "Avatar Studio",
        dressingRoom: "Dressing Room",
        customize: "Customize Avatar",
        randomize: "Randomize",
        save: "Save",
        joinRoomBtn: "Join Room",
        waitingForPlayers: "Waiting for players to join...",
        playersInLobby: "players in lobby",
        playerInLobby: "player in lobby",
        finalResults: "FINAL RESULTS",
        leaderboard: "LEADERBOARD",
        getReady: "GET READY",
        go: "GO!",
        startGame: "Start Game",
        buzz: "BUZZ!",
        gameOver: "Game Over!",
        playAgain: "Play Again",
        rematch: "Rematch",
        backToMenu: "Menu",
        reconnecting: "Reconnecting...",
        players: "Players",
        scores: "Scores:",
        finalScores: "Final Scores:",
        host: "HOST",
        selectSubjects: "Select Subjects:",
        selectGameMode: "Select Game Mode:",
        freeForAll: "🎯 Free for All (2+ players)",
        teamMode: "👥 Team Mode (4 players exactly)",
        selectTeam: "Select Your Team:",
        teamFull: "That team is full!",
        teamRed: "Red Team",
        teamBlue: "Blue Team",
        teamScores: "Team Scores",
        alertBothFields: "Please enter both room code and name",
        alertName: "Please enter your name",
        alertSubjects: "Please select at least one subject",
        connectionError: "Connection error. Please try again.",
        buzzerKey: "Buzzer Key:",
        changeKey: "Change Key",
        pressAnyKey: "Press any key...",
        backgroundMusic: "Background Music:",
        musicOn: "Music: On",
        musicOff: "Music: Off",
        soundEffects: "Sound Effects:",
        sfxOn: "SFX: On",
        sfxOff: "SFX: Off",
        score: "Score",
        correct: "✅ Correct!",
        wrong: "❌ Wrong! Correct answer:",
        timeout: "⏰ Time's up!",
        round: "Round",
        question: "Question",
        winner: "Winner",
        // Public rooms translations
        roomVisibility: "Room Visibility:",
        privateRoom: "Private",
        publicRoom: "Public",
        privateDesc: "Code required",
        publicDesc: "Visible to all",
        publicRooms: "Public Rooms",
        noPublicRooms: "No public rooms available",
        orJoinPrivate: "OR join a private room",
        join: "Join",
        // Voice chat translations
        voiceChat: "Voice Chat",
        joinVoice: "Join Voice",
        leaveVoice: "Leave Voice",
        voiceConnecting: "Connecting...",
        voiceConnected: "Connected",
        voiceDisconnected: "Disconnected",
        // Custom category (AI) translations
        customCategoryLabel: "🤖 Custom Category (AI)",
        customCategoryPlaceholder: "E.g.: Harry Potter, Italian Cuisine, Football...",
        customCategoryHint: "AI will generate questions on your chosen topic",
        orDivider: "OR",
        aiLoading: "Generating questions...",
        aiLoadingText: "AI is preparing your questions about",
        aiLoadingRetry: "AI is waking up... Attempt",
        aiLoadingWait: "This may take a few seconds",
        aiErrorTimeout: "AI is taking too long to respond. Please try again later or choose a predefined category.",
        aiErrorGeneration: "Error generating questions. Please try again.",
        aiErrorConnection: "Connection error. Please try again.",
        selectAll: "Select All",
        deselectAll: "Deselect All",
        advancedOptions: "Advanced Options",
        // Home screen
        welcome: "Welcome",
        guest: "Guest",
        playAsGuest: "Play as Guest",
        loginOrRegister: "Login / Register",
        globalLeaderboard: "Global Leaderboard",
        editAvatar: "Edit Avatar",
        logout: "Logout",
        // Auth
        username: "Username",
        password: "Password",
        login: "Login",
        register: "Register",
        // Stats
        gamesPlayed: "Games Played",
        gamesWon: "Games Won",
        highScore: "High Score",
        subjects: {
            science: "🔬 Science",
            history: "📚 History",
            geography: "🌍 Geography",
            sports: "⚽ Sports",
            technology: "💻 Technology",
            food: "🍕 Food & Cooking",
            music: "🎵 Music",
            tv_shows: "📺 TV Shows",
            anime: "🎌 Anime",
            image_riddles: "🖼️ Image Riddles",
            flags: "🏳️ World Flags",
            picguess: "🔍 Picture Guess"
        }
    },
    fr: {
        title: "🎯 Questions pour un Champion",
        settings: "Paramètres",
        selectLanguage: "Sélectionner la langue:",
        selectTheme: "Sélectionner le thème:",
        done: "Terminé",
        soloMode: "🎮 Mode Solo",
        multiplayerMode: "👥 Mode Multijoueur",
        createRoom: "Créer une salle",
        joinRoom: "Rejoindre une salle",
        enterRoomCode: "Entrez le code de la salle (ex: ABCD)",
        yourName: "Votre nom",
        createAndJoin: "Créer et rejoindre",
        back: "Retour",
        roomCode: "Code de la salle",
        continue: "Continuer",
        // Avatar translations
        avatarStudio: "Studio Avatar",
        dressingRoom: "Vestiaire",
        customize: "Personnaliser l'avatar",
        randomize: "Aléatoire",
        save: "Sauvegarder",
        joinRoomBtn: "Rejoindre la salle",
        waitingForPlayers: "En attente de joueurs...",
        playersInLobby: "joueurs dans le salon",
        playerInLobby: "joueur dans le salon",
        finalResults: "RÉSULTATS FINAUX",
        leaderboard: "CLASSEMENT",
        getReady: "PRÉPAREZ-VOUS",
        go: "C'EST PARTI!",
        startGame: "Démarrer le jeu",
        buzz: "BUZZ!",
        gameOver: "Jeu terminé!",
        playAgain: "Rejouer",
        rematch: "Revanche",
        backToMenu: "Menu",
        reconnecting: "Reconnexion...",
        players: "Joueurs",
        scores: "Scores:",
        finalScores: "Scores finaux:",
        host: "HÔTE",
        selectSubjects: "Sélectionner les sujets:",
        selectGameMode: "Sélectionner le mode de jeu:",
        freeForAll: "🎯 Tous contre tous (2+ joueurs)",
        teamMode: "👥 Mode Équipe (exactement 4 joueurs)",
        selectTeam: "Sélectionnez votre équipe:",
        teamFull: "Cette équipe est pleine!",
        teamRed: "Équipe Rouge",
        teamBlue: "Équipe Bleue",
        teamScores: "Scores des équipes",
        alertBothFields: "Veuillez entrer le code de la salle et votre nom",
        alertName: "Veuillez entrer votre nom",
        alertSubjects: "Veuillez sélectionner au moins un sujet",
        connectionError: "Erreur de connexion. Veuillez réessayer.",
        buzzerKey: "Touche Buzzer:",
        changeKey: "Changer",
        pressAnyKey: "Appuyez sur une touche...",
        backgroundMusic: "Musique de fond:",
        musicOn: "Musique: Activée",
        musicOff: "Musique: Désactivée",
        soundEffects: "Effets sonores:",
        sfxOn: "SFX: Activés",
        sfxOff: "SFX: Désactivés",
        score: "Score",
        correct: "✅ Correct !",
        wrong: "❌ Faux ! Bonne réponse:",
        timeout: "⏰ Temps écoulé !",
        round: "Manche",
        question: "Question",
        winner: "Gagnant",
        // Public rooms translations
        roomVisibility: "Visibilité de la salle:",
        privateRoom: "Privée",
        publicRoom: "Publique",
        privateDesc: "Code requis",
        publicDesc: "Visible par tous",
        publicRooms: "Salles publiques",
        noPublicRooms: "Aucune salle publique disponible",
        orJoinPrivate: "OU rejoindre une salle privée",
        join: "Rejoindre",
        // Voice chat translations
        voiceChat: "Chat Vocal",
        joinVoice: "Rejoindre",
        leaveVoice: "Quitter",
        voiceConnecting: "Connexion...",
        voiceConnected: "Connecté",
        voiceDisconnected: "Déconnecté",
        // Custom category (AI) translations
        customCategoryLabel: "🤖 Catégorie Personnalisée (IA)",
        customCategoryPlaceholder: "Ex: Harry Potter, Cuisine Italienne, Football...",
        customCategoryHint: "L'IA générera des questions sur le thème de votre choix",
        orDivider: "OU",
        aiLoading: "Génération des questions...",
        aiLoadingText: "L'IA prépare vos questions sur",
        aiLoadingRetry: "L'IA se réveille... Tentative",
        aiLoadingWait: "Cela peut prendre quelques secondes",
        aiErrorTimeout: "L'IA prend trop de temps à répondre. Veuillez réessayer plus tard ou choisir une catégorie prédéfinie.",
        aiErrorGeneration: "Erreur lors de la génération des questions. Veuillez réessayer.",
        aiErrorConnection: "Erreur de connexion. Veuillez réessayer.",
        selectAll: "Tout sélectionner",
        deselectAll: "Tout désélectionner",
        advancedOptions: "Options avancées",
        // Home screen
        welcome: "Bienvenue",
        guest: "Invité",
        playAsGuest: "Jouer en tant qu'invité",
        loginOrRegister: "Connexion / Inscription",
        globalLeaderboard: "Classement Mondial",
        editAvatar: "Modifier l'avatar",
        logout: "Déconnexion",
        // Auth
        username: "Nom d'utilisateur",
        password: "Mot de passe",
        login: "Connexion",
        register: "S'inscrire",
        // Stats
        gamesPlayed: "Parties jouées",
        gamesWon: "Parties gagnées",
        highScore: "Meilleur score",
        subjects: {
            science: "🔬 Science",
            history: "📚 Histoire",
            geography: "🌍 Géographie",
            sports: "⚽ Sports",
            technology: "💻 Technologie",
            music: "🎵 Musique",
            food: "🍕 Cuisine & Alimentation",
            tv_shows: "📺 Séries TV",
            anime: "🎌 Anime",
            image_riddles: "🖼️ Devinettes en Images",
            flags: "🏳️ Drapeaux du Monde",
            picguess: "🔍 Image Mystère"
        }
    }
};

// ============================================
// CONSTANTS & STATE
// ============================================

const SUBJECTS = [
    'science', 'history', 'geography', 'sports', 'music', 'food', 'tv_shows', 'anime', 'image_riddles',
    'flags', 'picguess'
];

let ws;
let userId;
let matchToken;
let isHost = false;
let currentRoomCode;
let hasBuzzed = false;
let canAnswer = false;
let timerInterval;
let selectedLanguage = 'en';
let selectedTheme = 'neon';
let gameMode = null;
let selectedGameMode = 'ffa';
let myTeam = null;
let selectedJoinTeam = null;
let roomGameMode = null;
let isCheckingRoom = false;
let currentMultiQuestion = null;
let currentLobbyPlayerCount = 0; // Track player count for lobby display

// Buzzer key settings
let buzzerKey = localStorage.getItem('triviaBuzzerKey') || 'Space';
let buzzerKeyDisplay = localStorage.getItem('triviaBuzzerKeyDisplay') || 'SPACE';
let isCapturingKey = false;

// Music settings
let musicPlayer = null;
let isMusicPlaying = false;
let musicVolume = parseInt(localStorage.getItem('triviaMusicVolume')) || 30;
let sfxVolume = parseInt(localStorage.getItem('triviaSfxVolume')) || 70;
let sfxEnabled = localStorage.getItem('triviaSfxEnabled') !== 'false';

const themeMusicUrls = {
    neon: '/static/music/neon.mp3',
    dragon: '/static/music/dragon.mp3',
    horror: '/static/music/horror.mp3', // Creepy ambient horror music
    sakura: '/static/music/sakura.mp3',
    midnight: '/static/music/midnight.mp3',
    clean: '/static/music/clean.mp3'
};

// ============================================
// SOUND SYSTEM — Web Audio Synthesis
// ============================================

let audioContext = null;

function initAudio() {
    if (audioContext) return;
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') audioContext.resume();
    } catch(e) {}
}

// Init on first interaction (required by mobile browsers)
['click', 'touchstart', 'keydown'].forEach(evt => {
    document.addEventListener(evt, function() { initAudio(); }, { once: true });
});

function playSfx(soundName) {
    if (!sfxEnabled) return;
    if (!audioContext) initAudio();
    if (!audioContext) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    
    try {
        const vol = (sfxVolume || 50) / 100;
        const t = audioContext.currentTime;
        
        switch(soundName) {
            case 'buzzer': {
                const g = audioContext.createGain();
                g.connect(audioContext.destination);
                g.gain.setValueAtTime(vol * 0.4, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
                const o1 = audioContext.createOscillator();
                o1.type = 'square'; o1.frequency.value = 180;
                o1.frequency.exponentialRampToValueAtTime(80, t + 0.2);
                o1.connect(g); o1.start(t); o1.stop(t + 0.25);
                const o2 = audioContext.createOscillator();
                o2.type = 'sawtooth'; o2.frequency.value = 120;
                const g2 = audioContext.createGain();
                g2.connect(audioContext.destination);
                g2.gain.setValueAtTime(vol * 0.2, t);
                g2.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
                o2.connect(g2); o2.start(t); o2.stop(t + 0.15);
                break;
            }
            case 'correct': {
                [523, 659, 784].forEach((freq, i) => {
                    const ot = t + i * 0.08;
                    const o = audioContext.createOscillator();
                    const g = audioContext.createGain();
                    o.type = 'sine'; o.frequency.value = freq;
                    g.gain.setValueAtTime(vol * 0.3, ot);
                    g.gain.exponentialRampToValueAtTime(0.001, ot + 0.3);
                    o.connect(g); g.connect(audioContext.destination);
                    o.start(ot); o.stop(ot + 0.3);
                });
                break;
            }
            case 'wrong': {
                const o = audioContext.createOscillator();
                const g = audioContext.createGain();
                o.type = 'sawtooth'; o.frequency.value = 200;
                o.frequency.exponentialRampToValueAtTime(40, t + 0.5);
                g.gain.setValueAtTime(vol * 0.3, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
                o.connect(g); g.connect(audioContext.destination);
                o.start(t); o.stop(t + 0.5);
                break;
            }
            case 'victory': {
                [523, 659, 784, 1047].forEach((freq, i) => {
                    const ot = t + i * 0.12;
                    const o = audioContext.createOscillator();
                    const g = audioContext.createGain();
                    o.type = 'sine'; o.frequency.value = freq;
                    g.gain.setValueAtTime(vol * 0.25, ot);
                    g.gain.exponentialRampToValueAtTime(0.001, ot + 0.5);
                    o.connect(g); g.connect(audioContext.destination);
                    o.start(ot); o.stop(ot + 0.5);
                });
                break;
            }
            case 'tick': {
                const o = audioContext.createOscillator();
                const g = audioContext.createGain();
                o.type = 'sine'; o.frequency.value = 1000;
                g.gain.setValueAtTime(vol * 0.15, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
                o.connect(g); g.connect(audioContext.destination);
                o.start(t); o.stop(t + 0.05);
                break;
            }
            case 'countdown': {
                const o = audioContext.createOscillator();
                const g = audioContext.createGain();
                o.type = 'sine'; o.frequency.value = 440;
                g.gain.setValueAtTime(vol * 0.3, t);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
                o.connect(g); g.connect(audioContext.destination);
                o.start(t); o.stop(t + 0.15);
                break;
            }
        }
    } catch(e) {}
}


function toggleSfx() {
    sfxEnabled = !sfxEnabled;
    localStorage.setItem('triviaSfxEnabled', sfxEnabled);
    updateSfxToggleUI();
}

function setSfxVolume(value) {
    sfxVolume = parseInt(value);
    localStorage.setItem('triviaSfxVolume', sfxVolume);
    // Volume is applied when sounds are played
}

function updateSfxToggleUI() {
    const sfxIcon = document.getElementById('sfxIcon');
    const sfxToggleBtn = document.getElementById('sfxToggleBtn');
    const sfxStatus = document.getElementById('sfxStatus');
    
    if (sfxIcon) {
        sfxIcon.textContent = sfxEnabled ? '🔔' : '🔕';
    }
    
    if (sfxToggleBtn) {
        if (sfxEnabled) {
            sfxToggleBtn.classList.add('enabled');
            sfxToggleBtn.classList.remove('disabled');
        } else {
            sfxToggleBtn.classList.remove('enabled');
            sfxToggleBtn.classList.add('disabled');
        }
    }
    
    if (sfxStatus) {
        sfxStatus.textContent = sfxEnabled ? t('sfxOn') : t('sfxOff');
    }
}

function loadThemeMusic(theme) {
    const musicUrl = themeMusicUrls[theme] || themeMusicUrls.neon;
    
    if (musicPlayer) {
        const wasPlaying = isMusicPlaying;
        
        // Pause current music
        musicPlayer.pause();
        
        // Load new track
        musicPlayer.src = musicUrl;
        musicPlayer.load();
        
        // Resume if was playing
        if (wasPlaying) {
            musicPlayer.play().catch(e => console.log('Music autoplay prevented:', e));
        }
    }
}

function toggleMusic() {
    if (!musicPlayer) {
        initMusic();
    }
    
    if (isMusicPlaying) {
        musicPlayer.pause();
        isMusicPlaying = false;
        updateMusicUI();
    } else {
        // Make sure the source is set
        if (!musicPlayer.src || musicPlayer.src === '') {
            loadThemeMusic(selectedTheme);
        }
        
        const playPromise = musicPlayer.play();
        
        if (playPromise !== undefined) {
            playPromise.then(() => {
                isMusicPlaying = true;
                updateMusicUI();
            }).catch(e => {
                console.log('Music play error:', e.message);
                console.log('Music src:', musicPlayer.src);
                console.log('Music ready state:', musicPlayer.readyState);
                isMusicPlaying = false;
                updateMusicUI();
            });
        }
    }
}

function setVolume(value) {
    musicVolume = parseInt(value);
    localStorage.setItem('triviaMusicVolume', musicVolume);
    
    if (musicPlayer) {
        musicPlayer.volume = musicVolume / 100;
    }
}

function updateMusicUI() {
    const musicIcon = document.getElementById('musicIcon');
    const musicToggleBtn = document.getElementById('musicToggleBtn');
    const musicStatus = document.getElementById('musicStatus');
    
    if (musicIcon) {
        musicIcon.textContent = isMusicPlaying ? '🔊' : '🔇';
    }
    
    if (musicToggleBtn) {
        if (isMusicPlaying) {
            musicToggleBtn.classList.add('playing');
        } else {
            musicToggleBtn.classList.remove('playing');
        }
    }
    
    if (musicStatus) {
        musicStatus.textContent = isMusicPlaying ? t('musicOn') : t('musicOff');
    }
}

function setupEventListeners() {
    const joinCodeInput = document.getElementById('joinCode');
    if (joinCodeInput) {
        let debounceTimer;
        joinCodeInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            e.target.value = e.target.value.toUpperCase();
            if (e.target.value.length >= 4) {
                debounceTimer = setTimeout(checkRoomMode, 300);
            } else {
                const teamSelectionDiv = document.getElementById('teamSelectionDiv');
                if (teamSelectionDiv) teamSelectionDiv.style.display = 'none';
                roomGameMode = null;
            }
        });
    }
}

// ============================================
// THEME MANAGEMENT
// ============================================

function setTheme(themeName) {
    selectedTheme = themeName;
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('triviaTheme', themeName);
    updateThemeUI();
    updateParticlesColor();
    
    // Change music to match theme
    loadThemeMusic(themeName);
    
    // Start horror effects if horror theme selected
    if (themeName === 'horror') {
        startHorrorEffects();
    } else {
        stopHorrorEffects();
    }
}

// ============================================
// HORROR THEME EFFECTS
// ============================================

let horrorActive = false;
let horrorIntervals = [];
let horrorTimeouts = [];

const horrorMessages = [
    "Regarde derrière toi...",
    "Je suis dans tes murs...",
    "Ne cligne pas des yeux...",
    "Quelqu'un respire dans ton dos...",
    "Je te vois jouer...",
    "Tu ne peux pas gagner...",
    "Le silence avant la tempête...",
    "Sens-tu cette présence ?",
    "Tes réponses ne te sauveront pas..."
];

function startHorrorEffects() {
    if (horrorActive) return;
    horrorActive = true;
    console.log("👻 Horror effects activated");
    
    // Create horror overlay container
    if (!document.getElementById('horror-overlay-container')) {
        const container = document.createElement('div');
        container.id = 'horror-overlay-container';
        container.innerHTML = `
            <style>
                #horror-overlay-container {
                    pointer-events: none;
                    position: fixed;
                    top: 0; left: 0;
                    width: 100%; height: 100%;
                    z-index: 9999;
                }
                
                .horror-flicker {
                    animation: horrorFlicker 0.1s infinite;
                }
                
                @keyframes horrorFlicker {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.8; }
                }
                
                .horror-notification {
                    position: fixed;
                    right: -300px;
                    background: rgba(20, 0, 0, 0.95);
                    color: #ff0000;
                    padding: 15px 20px;
                    border-left: 3px solid #ff0000;
                    font-family: 'Creepster', cursive, sans-serif;
                    font-size: 14px;
                    z-index: 10000;
                    transition: right 0.5s ease;
                    box-shadow: -5px 0 20px rgba(255, 0, 0, 0.3);
                    max-width: 280px;
                }
                
                .horror-notification.show {
                    right: 20px;
                }
                
                .horror-notification::before {
                    content: '👻';
                    margin-right: 10px;
                }
                
                .horror-demon {
                    position: fixed;
                    width: 150px;
                    height: 200px;
                    background: radial-gradient(ellipse at center, rgba(255,0,0,0.3) 0%, transparent 70%);
                    opacity: 0;
                    transition: opacity 2s ease;
                    pointer-events: none;
                    z-index: 9998;
                }
                
                .horror-demon::after {
                    content: '👁️';
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    font-size: 60px;
                    filter: drop-shadow(0 0 10px red);
                    animation: demonPulse 2s infinite;
                }
                
                @keyframes demonPulse {
                    0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.7; }
                    50% { transform: translate(-50%, -50%) scale(1.1); opacity: 1; }
                }
                
                .horror-glitch-text {
                    animation: glitchText 0.3s infinite;
                }
                
                @keyframes glitchText {
                    0% { transform: translate(0); }
                    20% { transform: translate(-2px, 2px); }
                    40% { transform: translate(-2px, -2px); }
                    60% { transform: translate(2px, 2px); }
                    80% { transform: translate(2px, -2px); }
                    100% { transform: translate(0); }
                }
                
                .horror-vignette {
                    position: fixed;
                    top: 0; left: 0;
                    width: 100%; height: 100%;
                    background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.8) 100%);
                    pointer-events: none;
                    z-index: 9997;
                    opacity: 0;
                    transition: opacity 3s ease;
                }
                
                .horror-scanlines {
                    position: fixed;
                    top: 0; left: 0;
                    width: 100%; height: 100%;
                    background: repeating-linear-gradient(
                        0deg,
                        rgba(0, 0, 0, 0.1),
                        rgba(0, 0, 0, 0.1) 1px,
                        transparent 1px,
                        transparent 2px
                    );
                    pointer-events: none;
                    z-index: 9996;
                    opacity: 0;
                    transition: opacity 2s ease;
                }
                
                .horror-blood-drip {
                    position: fixed;
                    top: -50px;
                    width: 8px;
                    height: 50px;
                    background: linear-gradient(to bottom, #8B0000, #FF0000);
                    border-radius: 0 0 4px 4px;
                    animation: bloodDrip 4s ease-in forwards;
                    z-index: 9999;
                }
                
                @keyframes bloodDrip {
                    0% { top: -50px; height: 50px; }
                    70% { top: 100vh; height: 100px; }
                    100% { top: 100vh; height: 0; opacity: 0; }
                }
                
                .horror-jumpscare {
                    position: fixed;
                    top: 0; left: 0;
                    width: 100%; height: 100%;
                    background: black;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10001;
                    opacity: 0;
                    pointer-events: none;
                }
                
                .horror-jumpscare.active {
                    opacity: 1;
                    animation: jumpscareFlash 0.5s ease;
                }
                
                .horror-jumpscare span {
                    font-size: 150px;
                    filter: drop-shadow(0 0 30px red);
                }
                
                @keyframes jumpscareFlash {
                    0% { opacity: 0; }
                    10% { opacity: 1; }
                    90% { opacity: 1; }
                    100% { opacity: 0; }
                }
                
                .cursor-horror {
                    cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Ctext x='0' y='24' font-size='24'%3E🩸%3C/text%3E%3C/svg%3E"), auto !important;
                }
            </style>
            
            <div class="horror-vignette" id="horror-vignette"></div>
            <div class="horror-scanlines" id="horror-scanlines"></div>
            <div class="horror-demon" id="horror-demon"></div>
            <div class="horror-jumpscare" id="horror-jumpscare"><span>👹</span></div>
        `;
        document.body.appendChild(container);
    }
    
    // Activate vignette and scanlines
    setTimeout(() => {
        const vignette = document.getElementById('horror-vignette');
        const scanlines = document.getElementById('horror-scanlines');
        if (vignette) vignette.style.opacity = '1';
        if (scanlines) scanlines.style.opacity = '0.3';
    }, 1000);
    
    // Add horror cursor
    document.body.classList.add('cursor-horror');
    
    // Start random horror events
    startHorrorNotifications();
    startHorrorDemon();
    startBloodDrips();
    startRandomGlitches();
    startRandomJumpscares();
}

function stopHorrorEffects() {
    if (!horrorActive) return;
    horrorActive = false;
    console.log("👻 Horror effects deactivated");
    
    // Clear all intervals and timeouts
    horrorIntervals.forEach(i => clearInterval(i));
    horrorTimeouts.forEach(t => clearTimeout(t));
    horrorIntervals = [];
    horrorTimeouts = [];
    
    // Remove horror elements
    const container = document.getElementById('horror-overlay-container');
    if (container) container.remove();
    
    // Remove horror cursor
    document.body.classList.remove('cursor-horror');
    
    // Remove any glitch classes
    document.querySelectorAll('.horror-glitch-text, .horror-flicker').forEach(el => {
        el.classList.remove('horror-glitch-text', 'horror-flicker');
    });
}

function startHorrorNotifications() {
    // Random creepy notifications
    const interval = setInterval(() => {
        if (!horrorActive) return;
        
        if (Math.random() > 0.6) {
            showHorrorNotification(horrorMessages[Math.floor(Math.random() * horrorMessages.length)]);
        }
    }, 15000 + Math.random() * 20000); // Every 15-35 seconds
    
    horrorIntervals.push(interval);
    
    // First notification after 10 seconds
    const timeout = setTimeout(() => {
        if (horrorActive) {
            showHorrorNotification(horrorMessages[Math.floor(Math.random() * horrorMessages.length)]);
        }
    }, 10000);
    horrorTimeouts.push(timeout);
}

function showHorrorNotification(message) {
    const notif = document.createElement('div');
    notif.className = 'horror-notification';
    notif.textContent = message;
    notif.style.top = (20 + Math.random() * 60) + '%';
    
    const container = document.getElementById('horror-overlay-container');
    if (container) {
        container.appendChild(notif);
        
        // Slide in
        setTimeout(() => notif.classList.add('show'), 100);
        
        // Slide out and remove
        setTimeout(() => {
            notif.classList.remove('show');
            setTimeout(() => notif.remove(), 500);
        }, 4000);
    }
}

function startHorrorDemon() {
    const demon = document.getElementById('horror-demon');
    if (!demon) return;
    
    const interval = setInterval(() => {
        if (!horrorActive) return;
        
        if (Math.random() > 0.7) {
            // Position randomly
            demon.style.left = (Math.random() * 80 + 10) + '%';
            demon.style.top = (Math.random() * 80 + 10) + '%';
            
            // Fade in
            demon.style.opacity = '0.6';
            
            // Fade out after random time
            const timeout = setTimeout(() => {
                demon.style.opacity = '0';
            }, 2000 + Math.random() * 3000);
            horrorTimeouts.push(timeout);
        }
    }, 20000 + Math.random() * 30000); // Every 20-50 seconds
    
    horrorIntervals.push(interval);
}

function startBloodDrips() {
    const interval = setInterval(() => {
        if (!horrorActive) return;
        
        if (Math.random() > 0.5) {
            createBloodDrip();
        }
    }, 10000 + Math.random() * 15000); // Every 10-25 seconds
    
    horrorIntervals.push(interval);
}

function createBloodDrip() {
    const drip = document.createElement('div');
    drip.className = 'horror-blood-drip';
    drip.style.left = (Math.random() * 100) + '%';
    
    const container = document.getElementById('horror-overlay-container');
    if (container) {
        container.appendChild(drip);
        setTimeout(() => drip.remove(), 5000);
    }
}

function startRandomGlitches() {
    const interval = setInterval(() => {
        if (!horrorActive) return;
        
        if (Math.random() > 0.7) {
            // Glitch the title or question text
            const targets = document.querySelectorAll('.title, .question-text, h1, h2');
            const target = targets[Math.floor(Math.random() * targets.length)];
            
            if (target) {
                target.classList.add('horror-glitch-text');
                const timeout = setTimeout(() => {
                    target.classList.remove('horror-glitch-text');
                }, 500 + Math.random() * 1000);
                horrorTimeouts.push(timeout);
            }
            
            // Also flicker the screen occasionally
            if (Math.random() > 0.8) {
                document.body.classList.add('horror-flicker');
                const timeout2 = setTimeout(() => {
                    document.body.classList.remove('horror-flicker');
                }, 200);
                horrorTimeouts.push(timeout2);
            }
        }
    }, 8000 + Math.random() * 12000); // Every 8-20 seconds
    
    horrorIntervals.push(interval);
}

function startRandomJumpscares() {
    // Very rare jumpscares (only on wrong answers in horror mode)
    // This will be triggered from the answer handler
}

function triggerHorrorJumpscare() {
    if (!horrorActive) return;
    
    const jumpscare = document.getElementById('horror-jumpscare');
    if (jumpscare) {
        // Random scary emoji
        const scaryEmojis = ['👹', '👺', '💀', '👻', '🎃', '😈'];
        jumpscare.querySelector('span').textContent = scaryEmojis[Math.floor(Math.random() * scaryEmojis.length)];
        
        jumpscare.classList.add('active');
        
        // Play scare sound if available
        playSfx('horror_scare');
        
        setTimeout(() => {
            jumpscare.classList.remove('active');
        }, 500);
    }
}

function updateThemeUI() {
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.classList.remove('selected');
        if (opt.dataset.theme === selectedTheme) {
            opt.classList.add('selected');
        }
    });
}

function updateParticlesColor() {
    const themeColors = {
        neon: '#0ff',
        dragon: '#ff6b35',
        ocean: '#00b4d8',
        sakura: '#ffb7c5',
        midnight: '#e94560',
        clean: '#4361ee',
        horror: '#8B0000'
    };
    
    const color = themeColors[selectedTheme] || '#0ff';
    document.querySelectorAll('.particle').forEach(p => {
        p.style.background = color;
        p.style.boxShadow = `0 0 10px ${color}`;
    });
}

// ============================================
// LANGUAGE MANAGEMENT
// ============================================

function t(key) {
    const keys = key.split('.');
    let value = translations[selectedLanguage];
    for (const k of keys) {
        value = value?.[k];
        if (!value) break;
    }
    return value || translations.en[key] || key;
}

function applyTranslations() {
    document.querySelectorAll('[data-translate]').forEach(element => {
        const key = element.getAttribute('data-translate');
        const text = t(key);
        if (text) element.textContent = text;
    });

    document.querySelectorAll('[data-translate-placeholder]').forEach(element => {
        const key = element.getAttribute('data-translate-placeholder');
        const text = t(key);
        if (text) element.placeholder = text;
    });
    
    // Update lobby player count if in lobby
    if (currentLobbyPlayerCount > 0) {
        updateLobbyPlayerCount();
    }
    
    // Re-render subjects if visible
    renderSubjects();
}

function selectLanguage(lang) {
    selectedLanguage = lang;
    localStorage.setItem('triviaLanguage', lang);
    updateLanguageUI();
    applyTranslations();

    if (ws && ws.readyState === WebSocket.OPEN && userId) {
        ws.send(JSON.stringify({
            action: 'changeLanguage',
            userId: userId,
            matchToken: matchToken,
            language: lang
        }));
    }
}

function updateLanguageUI() {
    document.querySelectorAll('.language-option').forEach(opt => {
        opt.classList.remove('selected');
        if (opt.dataset.lang === selectedLanguage) {
            opt.classList.add('selected');
        }
    });
}

// ============================================
// SETTINGS MODAL
// ============================================

function openSettings() {
    document.getElementById('settingsModal').classList.add('active');
    updateLanguageUI();
    updateThemeUI();
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
}

// ============================================
// SCREEN NAVIGATION
// ============================================

function showScreen(screenId) {
    const currentScreen = document.querySelector('.screen.active');
    const newScreen = document.getElementById(screenId);
    if (!newScreen) return;
    
    if (currentScreen && currentScreen.id !== screenId) {
        // Crossfade: new screen enters WHILE old exits
        newScreen.classList.add('active', 'screen-entering');
        currentScreen.classList.add('screen-exiting');
        
        setTimeout(() => {
            currentScreen.classList.remove('active', 'screen-exiting');
            newScreen.classList.remove('screen-entering');
        }, 300);
    } else {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'screen-exiting', 'screen-entering'));
        newScreen.classList.add('active');
    }
}

function showHome() { 
    showScreen('homeScreen'); 
    updateAllAvatarDisplays();
}

function copyRoomCode() {
    const code = document.getElementById('roomCode')?.textContent;
    if (code && code !== '----') {
        navigator.clipboard.writeText(code).then(() => {
            const el = document.getElementById('roomCode');
            if (el) { el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1500); }
            showMessage('📋 Code copied!');
        }).catch(() => {});
    }
}

function showSoloSetup() {
    showScreen('soloSetupScreen');
    setTimeout(renderSubjects, 300);
}

function showMultiMode() { showScreen('multiModeScreen'); }

function showCreateMulti() {
    showScreen('createMultiScreen');
    setTimeout(renderSubjects, 300);
}

function showJoinMulti() {
    showScreen('joinMultiScreen');
    selectedJoinTeam = null;
    roomGameMode = null;
    isCheckingRoom = false;
    const teamSelectionDiv = document.getElementById('teamSelectionDiv');
    if (teamSelectionDiv) teamSelectionDiv.style.display = 'none';
    resetTeamButtonStyles();
    const joinCodeInput = document.getElementById('joinCode');
    if (joinCodeInput) joinCodeInput.value = '';
    
    // Connect to lobby for public rooms
    connectToLobby();
}

// ============================================
// PUBLIC ROOMS & LOBBY
// ============================================

let lobbyWs = null;
let selectedRoomVisibility = 'private';

function connectToLobby() {
    if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) {
        return;
    }
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    lobbyWs = new WebSocket(`${protocol}//${location.host}/ws/LOBBY`);
    
    lobbyWs.onopen = () => {
        lobbyWs.send(JSON.stringify({ action: 'joinLobby' }));
    };
    
    lobbyWs.onmessage = (e) => {
        const { event, data } = JSON.parse(e.data);
        if (event === 'publicRooms') {
            renderPublicRooms(data);
        }
    };
    
    lobbyWs.onerror = (e) => {
        console.log('Lobby connection error:', e);
    };
    
    lobbyWs.onclose = () => {
        lobbyWs = null;
    };
}

function disconnectFromLobby() {
    if (lobbyWs) {
        lobbyWs.close();
        lobbyWs = null;
    }
}

function renderPublicRooms(rooms) {
    const container = document.getElementById('publicRoomsList');
    if (!container) return;
    
    if (!rooms || rooms.length === 0) {
        container.innerHTML = `<p class="no-rooms" data-translate="noPublicRooms">${t('noPublicRooms')}</p>`;
        return;
    }
    
    container.innerHTML = rooms.map(room => `
        <div class="public-room-item" onclick="joinPublicRoom('${room.code}')">
            <div class="public-room-info">
                <span class="public-room-host">🎮 ${room.hostName}</span>
                <span class="public-room-details">
                    ${room.gameMode === 'team' ? '👥 Team Mode' : '🎯 Free for All'} • 
                    ${room.playerCount}/${room.maxPlayers} ${t('players')}
                </span>
            </div>
            <button class="public-room-join">${t('join')}</button>
        </div>
    `).join('');
}

function joinPublicRoom(code) {
    const joinCodeInput = document.getElementById('joinCode');
    if (joinCodeInput) {
        joinCodeInput.value = code;
        // Trigger the room info check
        checkRoomMode();
    }
}

function selectVisibility(visibility) {
    selectedRoomVisibility = visibility;
    // New setup screen uses setupVisPrivate / setupVisPublic (handled inline onclick)
    // Legacy IDs for backward compat
    const privateItem = document.getElementById('visibilityPrivate') || document.getElementById('setupVisPrivate');
    const publicItem = document.getElementById('visibilityPublic') || document.getElementById('setupVisPublic');
    
    if (privateItem) privateItem.classList.remove('selected');
    if (publicItem) publicItem.classList.remove('selected');
    
    if (visibility === 'private' && privateItem) {
        privateItem.classList.add('selected');
    } else if (visibility === 'public' && publicItem) {
        publicItem.classList.add('selected');
    }
}

// ============================================
// GAME MODE & SUBJECT SELECTION
// ============================================

function selectGameMode(mode) {
    selectedGameMode = mode;
    // New setup screen uses setupModeFFA / setupModeTeam (handled inline onclick)
    // Legacy IDs for backward compat
    const ffaDiv = document.getElementById('gameModeFF') || document.getElementById('setupModeFFA');
    const teamDiv = document.getElementById('gameModeTeam') || document.getElementById('setupModeTeam');
    if (ffaDiv) ffaDiv.classList.remove('selected');
    if (teamDiv) teamDiv.classList.remove('selected');
    if (mode === 'ffa' && ffaDiv) ffaDiv.classList.add('selected');
    else if (mode === 'team' && teamDiv) teamDiv.classList.add('selected');
}

function renderSubjects() {
    const soloScreen = document.getElementById('soloSetupScreen');
    const createScreen = document.getElementById('createMultiScreen');
    // Render to both containers regardless of active state
    renderSubjectsToContainer('soloSubjects');
    renderSubjectsToContainer('createSubjects');
}

function renderSubjectsToContainer(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    
    const subjectEmojis = {
        science: '🔬', history: '🏛️', geography: '🌍', sports: '⚽',
        music: '🎵', food: '🍳', tv_shows: '📺', anime: '🎌',
        image_riddles: '🖼️', flags: '🏳️', picguess: '🔍'
    };
    
    const subjectDescs = {
        science: 'Physique, chimie, bio...', history: 'Événements et dates clés',
        geography: 'Pays, capitales, reliefs', sports: 'Football, JO, records',
        music: 'Artistes, genres, hits', food: 'Cuisine du monde entier',
        tv_shows: 'Séries et émissions TV', anime: 'Manga et animation',
        image_riddles: 'Devinez l\'image', flags: 'Drapeaux du monde',
        picguess: 'Image floue → devinez !'
    };
    
    SUBJECTS.forEach(subject => {
        const card = document.createElement('div');
        card.className = 'setup-cat-card selected';
        card.dataset.subject = subject;
        card.innerHTML = `
            <div class="cat-check">✓</div>
            <div class="cat-emoji">${subjectEmojis[subject] || '📚'}</div>
            <div class="cat-name">${t('subjects.' + subject)}</div>
            <div class="cat-desc">${subjectDescs[subject] || ''}</div>
        `;
        card.onclick = () => {
            card.classList.toggle('selected');
        };
        container.appendChild(card);
    });
}

function getSelectedSubjects(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.setup-cat-card.selected'))
        .map(card => card.dataset.subject)
        .filter(Boolean);
}

function toggleAllSubjects(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const cards = container.querySelectorAll('.setup-cat-card');
    const allSelected = Array.from(cards).every(c => c.classList.contains('selected'));
    cards.forEach(c => {
        if (allSelected) c.classList.remove('selected');
        else c.classList.add('selected');
    });
}

// Solo adaptive difficulty state
let soloAdaptive = { history: [], level: 'medium', streak: 0, responseTimes: [] };

function updateSoloAdaptive(correct, responseTime) {
    const WINDOW = 5;
    soloAdaptive.history.push(correct ? 1 : 0);
    if (soloAdaptive.history.length > WINDOW) soloAdaptive.history = soloAdaptive.history.slice(-WINDOW);
    soloAdaptive.responseTimes.push(responseTime);
    if (soloAdaptive.responseTimes.length > WINDOW) soloAdaptive.responseTimes = soloAdaptive.responseTimes.slice(-WINDOW);
    
    if (correct) soloAdaptive.streak = Math.max(0, soloAdaptive.streak) + 1;
    else soloAdaptive.streak = Math.min(0, soloAdaptive.streak) - 1;
    
    if (soloAdaptive.history.length >= 3) {
        const ratio = soloAdaptive.history.reduce((a, b) => a + b, 0) / soloAdaptive.history.length;
        if (ratio > 0.8 && soloAdaptive.streak >= 3) {
            if (soloAdaptive.level === 'easy') soloAdaptive.level = 'medium';
            else if (soloAdaptive.level === 'medium') soloAdaptive.level = 'hard';
        } else if (ratio < 0.4 || soloAdaptive.streak <= -2) {
            if (soloAdaptive.level === 'hard') soloAdaptive.level = 'medium';
            else if (soloAdaptive.level === 'medium') soloAdaptive.level = 'easy';
        }
    }
}

function getSoloAdaptiveModifiers() {
    const mods = { easy: { timerBonus: 5, scoreMultiplier: 0.8 }, medium: { timerBonus: 0, scoreMultiplier: 1.0 }, hard: { timerBonus: -3, scoreMultiplier: 1.5 } };
    return mods[soloAdaptive.level] || mods.medium;
}

function resetSoloAdaptive() {
    soloAdaptive = { history: [], level: 'medium', streak: 0, responseTimes: [] };
}

// Quiz type selection
let selectedQuizType = { solo: 'classic', multi: 'classic' };

function selectQuizType(mode, type, el) {
    selectedQuizType[mode] = type;
    const parent = el.closest('.setup-quiz-types');
    parent.querySelectorAll('.setup-quiz-type').forEach(t => t.classList.remove('selected'));
    el.classList.add('selected');
}

// ============================================
// TEAM SELECTION
// ============================================

function resetTeamButtonStyles() {
    ['joinTeamRed', 'joinTeamBlue'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('selected', 'disabled');
            el.style.opacity = '1';
            el.style.pointerEvents = 'auto';
        }
    });
}

function selectJoinTeam(team) {
    const redDiv = document.getElementById('joinTeamRed');
    const blueDiv = document.getElementById('joinTeamBlue');
    if (team === 'red' && redDiv?.classList.contains('disabled')) return;
    if (team === 'blue' && blueDiv?.classList.contains('disabled')) return;
    selectedJoinTeam = team;
    redDiv?.classList.remove('selected');
    blueDiv?.classList.remove('selected');
    if (team === 'red') redDiv?.classList.add('selected');
    else blueDiv?.classList.add('selected');
}

// ============================================
// WEBSOCKET HELPERS
// ============================================

function getWebSocketUrl(code) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws/${code}`;
}

// ============================================
// SOLO GAME
// ============================================

async function startSoloGame() {
    const nameEl = document.getElementById('soloName');
    const name = nameEl?.value.trim();
    const subjects = getSelectedSubjects('soloSubjects');
    const customCategoryEl = document.getElementById('customCategoryInput');
    const customCategory = customCategoryEl ? customCategoryEl.value.trim() : '';
    
    // Validation with visual feedback
    if (!name) {
        nameEl?.focus();
        nameEl?.classList.add('input-error');
        setTimeout(() => nameEl?.classList.remove('input-error'), 1500);
        showMessage('⚠️ ' + t('alertName')); return;
    }
    
    if (!customCategory && subjects.length === 0) {
        showMessage('⚠️ ' + t('alertSubjects')); return;
    }
    
    // Loading state on launch button
    const launchBtn = document.querySelector('#soloSetupScreen .setup-launch-btn');
    if (launchBtn) { launchBtn.disabled = true; launchBtn.textContent = '⏳ Chargement...'; }
    
    try {
        if (customCategory && customCategory.length > 0) {
            await startSoloGameWithAI(name, customCategory);
        } else if (subjects.length > 0) {
            await startSoloGameWithPredefined(name, subjects);
        }
    } finally {
        if (launchBtn) { launchBtn.disabled = false; launchBtn.textContent = '🚀 Lancer le Quiz'; }
    }
}

async function startSoloGameWithPredefined(name, subjects) {
    gameMode = 'solo';
    soloScore = 0;
    soloQuestionIndex = 0;
    resetSoloAdaptive();
    
    // Auto-include picguess questions when quiz type is picguess
    const soloQType = selectedQuizType.solo || 'classic';
    if (soloQType === 'picguess' && !subjects.includes('picguess')) {
        subjects = [...subjects, 'picguess'];
    }

    try {
        const response = await fetch(`/api/questions?language=${selectedLanguage}&subjects=${subjects.join(',')}`);
        const data = await response.json();
        soloQuestions = data.questions;
        if (soloQuestions.length === 0) { showMessage('⚠️ No questions available'); return; }
        showScreen('soloGameScreen');
        showNextSoloQuestion();
    } catch (error) {
        console.error('Error:', error);
        showMessage('⚠️ ' + t('connectionError'));
    }
}

async function startSoloGameWithAI(name, category, retryCount = 0) {
    const MAX_RETRIES = 5;
    
    // Show loading modal
    const loadingModal = document.getElementById('aiLoadingModal');
    const loadingCategory = document.getElementById('aiLoadingCategory');
    const loadingText = document.getElementById('aiLoadingText');
    
    if (loadingModal) loadingModal.style.display = 'flex';
    if (loadingCategory) loadingCategory.textContent = category;
    
    // Update loading text based on retry count
    if (loadingText) {
        if (retryCount === 0) {
            loadingText.innerHTML = `${t('aiLoadingText')} "<span id="aiLoadingCategory">${category}</span>"`;
        } else {
            loadingText.innerHTML = `${t('aiLoadingRetry')} ${retryCount}/${MAX_RETRIES} 🔄`;
        }
    }
    
    gameMode = 'solo';
    soloScore = 0;
    soloQuestionIndex = 0;
    resetSoloAdaptive();
    
    try {
        const response = await fetch('/api/generate-questions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category: category,
                count: 10,
                language: selectedLanguage
            })
        });
        
        const data = await response.json();
        
        if (data.success && data.questions && data.questions.length > 0) {
            // Hide loading modal
            if (loadingModal) loadingModal.style.display = 'none';
            
            // Transform AI questions to match game format
            soloQuestions = data.questions.map((q, idx) => {
                // Find the index of the correct answer in options
                const correctIndex = q.options.findIndex(opt => opt === q.answer);
                return {
                    q: q.question,
                    options: q.options,
                    correct: correctIndex >= 0 ? correctIndex : 0,  // Default to 0 if not found
                    time: 15  // Give a bit more time for AI questions
                };
            });
            
            showScreen('soloGameScreen');
            showNextSoloQuestion();
        } else if (data.retry && retryCount < MAX_RETRIES) {
            // Model is loading, auto-retry after delay
            console.log(`AI model loading, retry ${retryCount + 1}/${MAX_RETRIES}...`);
            setTimeout(() => startSoloGameWithAI(name, category, retryCount + 1), 3000);
        } else if (retryCount >= MAX_RETRIES) {
            // Max retries reached
            if (loadingModal) loadingModal.style.display = 'none';
            alert(t('aiErrorTimeout'));
        } else {
            if (loadingModal) loadingModal.style.display = 'none';
            alert(data.error || t('aiErrorGeneration'));
        }
    } catch (error) {
        console.error('Error generating AI questions:', error);
        if (retryCount < MAX_RETRIES) {
            console.log(`Network error, retry ${retryCount + 1}/${MAX_RETRIES}...`);
            setTimeout(() => startSoloGameWithAI(name, category, retryCount + 1), 3000);
        } else {
            if (loadingModal) loadingModal.style.display = 'none';
            alert(t('aiErrorConnection'));
        }
    }
}

// Handle custom category input - deselect subjects when typing
document.addEventListener('DOMContentLoaded', function() {
    // Solo mode custom category
    const customInput = document.getElementById('customCategoryInput');
    const soloSubjectsContainer = document.getElementById('soloSubjects');
    
    if (customInput) {
        customInput.addEventListener('input', function() {
            if (this.value.trim()) {
                // Deselect all subjects when custom category is entered
                if (soloSubjectsContainer) {
                    soloSubjectsContainer.classList.add('custom-category-active');
                    soloSubjectsContainer.querySelectorAll('.subject-btn').forEach(btn => {
                        btn.classList.remove('selected');
                    });
                }
            } else {
                if (soloSubjectsContainer) {
                    soloSubjectsContainer.classList.remove('custom-category-active');
                }
            }
        });
    }
    
    // Clear custom input when selecting a predefined subject
    if (soloSubjectsContainer) {
        soloSubjectsContainer.addEventListener('click', function(e) {
            if (e.target.classList.contains('subject-btn')) {
                if (customInput) {
                    customInput.value = '';
                    soloSubjectsContainer.classList.remove('custom-category-active');
                }
            }
        });
    }
    
    // Multiplayer mode custom category
    const customInputMulti = document.getElementById('customCategoryInputMulti');
    const createSubjectsContainer = document.getElementById('createSubjects');
    
    if (customInputMulti) {
        customInputMulti.addEventListener('input', function() {
            if (this.value.trim()) {
                // Deselect all subjects when custom category is entered
                if (createSubjectsContainer) {
                    createSubjectsContainer.classList.add('custom-category-active');
                    createSubjectsContainer.querySelectorAll('.subject-btn').forEach(btn => {
                        btn.classList.remove('selected');
                    });
                }
            } else {
                if (createSubjectsContainer) {
                    createSubjectsContainer.classList.remove('custom-category-active');
                }
            }
        });
    }
    
    // Clear custom input when selecting a predefined subject (multiplayer)
    if (createSubjectsContainer) {
        createSubjectsContainer.addEventListener('click', function(e) {
            if (e.target.classList.contains('subject-btn')) {
                if (customInputMulti) {
                    customInputMulti.value = '';
                    createSubjectsContainer.classList.remove('custom-category-active');
                }
            }
        });
    }
});

function showNextSoloQuestion() {
    if (soloQuestionIndex >= soloQuestions.length) { showSoloGameOver(); return; }

    soloCurrentQuestion = soloQuestions[soloQuestionIndex];
    
    // Update score badge
    const scoreEl = document.getElementById('soloScore');
    if (scoreEl) {
        const scoreValue = scoreEl.querySelector('.score-value');
        if (scoreValue) {
            scoreValue.textContent = soloScore;
        }
    }
    
    // Update question badge
    const questionBadge = document.getElementById('soloQuestionBadge');
    if (questionBadge) {
        const questionValue = questionBadge.querySelector('.question-value');
        if (questionValue) {
            questionValue.textContent = `${soloQuestionIndex + 1}/${soloQuestions.length}`;
        }
    }
    
    // Handle question image (for flag quiz etc.)
    const questionImageEl = document.getElementById('soloQuestionImage');
    if (questionImageEl) {
        if (soloCurrentQuestion.image) {
            questionImageEl.style.display = 'block';
            questionImageEl.querySelector('img').src = soloCurrentQuestion.image;
        } else {
            questionImageEl.style.display = 'none';
        }
    }
    
    const questionText = document.getElementById('soloQuestionText');
    if (questionText) questionText.textContent = soloCurrentQuestion.q;
    const questionNumber = document.getElementById('soloQuestionNumber');
    if (questionNumber) questionNumber.textContent = `${soloQuestionIndex + 1} / ${soloQuestions.length}`;

    // Add question enter animation
    const questionBox = document.querySelector('#soloGameScreen .question-box');
    if (questionBox) {
        questionBox.classList.remove('entering');
        void questionBox.offsetWidth; // Force reflow
        questionBox.classList.add('entering');
    }

    // Store time info for scoring — adjust for quiz type + adaptive difficulty
    const soloQType = selectedQuizType.solo || 'classic';
    let baseTime = soloCurrentQuestion.time || 10;
    if (soloQType === 'speed') baseTime = Math.max(5, Math.floor(baseTime / 2));
    else if (soloQType === 'picguess') baseTime = 15;
    
    // Apply adaptive timer modifier
    const adaptMods = getSoloAdaptiveModifiers();
    baseTime = Math.max(5, baseTime + adaptMods.timerBonus);
    
    window.soloTimeLeft = baseTime;
    window.soloMaxTime = window.soloTimeLeft;
    window.soloScoreMultiplier = adaptMods.scoreMultiplier;
    const timerEl = document.getElementById('soloTimer');
    
    // Use circular timer
    if (timerEl) {
        timerEl.innerHTML = createCircularTimer(window.soloTimeLeft, window.soloMaxTime);
    }

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        window.soloTimeLeft--;
        if (timerEl) {
            timerEl.innerHTML = createCircularTimer(window.soloTimeLeft, window.soloMaxTime);
        }
        if (window.soloTimeLeft <= 0) { 
            clearInterval(timerInterval); 
            handleSoloTimeout(); 
        }
    }, 1000);

    const optionsBox = document.getElementById('soloOptionsBox');
    if (optionsBox) {
        optionsBox.innerHTML = '';
        const soloQType = selectedQuizType.solo || 'classic';
        
        if (soloQType === 'truefalse') {
            // Convert to True/False for solo
            const correctOption = soloCurrentQuestion.options[soloCurrentQuestion.correct];
            const useCorrect = Math.random() > 0.5;
            let tfQuestion, tfCorrectIdx;
            if (useCorrect) {
                tfQuestion = `${soloCurrentQuestion.q} → ${correctOption}`;
                tfCorrectIdx = 0;
            } else {
                const wrongOpts = soloCurrentQuestion.options.filter((_, i) => i !== soloCurrentQuestion.correct);
                tfQuestion = `${soloCurrentQuestion.q} → ${wrongOpts[0] || correctOption}`;
                tfCorrectIdx = 1;
            }
            // Override question text
            document.getElementById('soloQuestionText').textContent = tfQuestion;
            soloCurrentQuestion = { ...soloCurrentQuestion, options: ['Vrai', 'Faux'], correct: tfCorrectIdx };
            
            optionsBox.style.gridTemplateColumns = 'repeat(2, 1fr)';
            const tfVariants = ['option--a', 'option--b'];
            soloCurrentQuestion.options.forEach((option, idx) => {
                const btn = document.createElement('button');
                btn.className = `option ${tfVariants[idx % 2]}`;
                const letter = document.createElement('span');
                letter.className = 'option__letter';
                letter.textContent = option === 'Vrai' ? '✅' : '❌';
                const text = document.createElement('span');
                text.className = 'option__text';
                text.textContent = option;
                btn.append(letter, text);
                btn.onclick = () => handleSoloAnswer(idx);
                btn.style.animationDelay = (idx * 0.06) + 's';
                optionsBox.appendChild(btn);
            });
        } else {
            optionsBox.style.gridTemplateColumns = 'repeat(2, 1fr)';
            const optLetters = ['A', 'B', 'C', 'D'];
            const optVariants = ['option--a', 'option--b', 'option--c', 'option--d'];
            soloCurrentQuestion.options.forEach((option, idx) => {
                const btn = document.createElement('button');
                btn.className = `option ${optVariants[idx % 4]}`;
                const letter = document.createElement('span');
                letter.className = 'option__letter';
                letter.textContent = optLetters[idx % 4];
                const text = document.createElement('span');
                text.className = 'option__text';
                text.textContent = option;
                btn.append(letter, text);
                btn.onclick = () => handleSoloAnswer(idx);
                btn.style.animationDelay = (idx * 0.06) + 's';
                optionsBox.appendChild(btn);
            });
        }
        
        // Picture Guess: progressive deblur
        if (soloQType === 'picguess' && soloCurrentQuestion.image) {
            const qImg = document.querySelector('#soloQuestionImage img');
            if (qImg) {
                document.getElementById('soloQuestionImage').style.display = 'block';
                qImg.src = soloCurrentQuestion.image;
                qImg.style.filter = 'blur(20px)';
                qImg.style.transition = `filter ${(soloCurrentQuestion.time || 10) * 1000}ms linear`;
                requestAnimationFrame(() => { qImg.style.filter = 'blur(0px)'; });
            }
        }
    }
    hideSoloMessage();
}

// Scoring constants
const WRONG_ANSWER_PENALTY = 5;  // Points lost for wrong answer
const MIN_CORRECT_POINTS = 10;   // Minimum points for correct answer
const MAX_CORRECT_POINTS = 100;  // Maximum points for correct answer (instant answer)

// Calculate score based on time left
function calculateTimeScore(timeLeft, maxTime) {
    // Score = MIN + (MAX - MIN) * (timeLeft / maxTime)
    // Fast answer = more points
    const timeRatio = Math.max(0, timeLeft / maxTime);
    const score = Math.round(MIN_CORRECT_POINTS + (MAX_CORRECT_POINTS - MIN_CORRECT_POINTS) * timeRatio);
    return score;
}

function handleSoloAnswer(idx) {
    clearInterval(timerInterval);
    const correct = idx === soloCurrentQuestion.correct;
    const responseTime = (window.soloMaxTime || 10) - (window.soloTimeLeft || 0);
    const scoreMultiplier = window.soloScoreMultiplier || 1.0;
    
    // Update adaptive difficulty state
    updateSoloAdaptive(correct, responseTime);
    
    if (correct) {
        // Calculate time-based score with adaptive multiplier
        const basePoints = calculateTimeScore(window.soloTimeLeft || 0, window.soloMaxTime || 10);
        const earnedPoints = Math.round(basePoints * scoreMultiplier);
        soloScore += earnedPoints;
        
        playSfx('correct');
        const scoreEl = document.getElementById('soloScore');
        if (scoreEl) {
            const scoreValue = scoreEl.querySelector('.score-value');
            if (scoreValue) scoreValue.textContent = soloScore;
            scoreEl.classList.remove('updated');
            void scoreEl.offsetWidth;
            scoreEl.classList.add('updated');
        }
        const multiplierLabel = scoreMultiplier > 1 ? ` (×${scoreMultiplier})` : '';
        showPointsPopup(`+${earnedPoints}${multiplierLabel}`, true);
        showFeedbackFlash(true);
        createConfetti(30);
        if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
    } else { 
        soloScore = Math.max(0, soloScore - WRONG_ANSWER_PENALTY);
        
        playSfx('wrong');
        
        if (selectedTheme === 'horror' && Math.random() > 0.7) {
            triggerHorrorJumpscare();
        }
        
        const scoreEl = document.getElementById('soloScore');
        if (scoreEl) {
            const scoreValue = scoreEl.querySelector('.score-value');
            if (scoreValue) scoreValue.textContent = soloScore;
            scoreEl.classList.remove('updated');
            void scoreEl.offsetWidth;
            scoreEl.classList.add('updated');
        }
        
        showPointsPopup(`-${WRONG_ANSWER_PENALTY}`, false);
        showFeedbackFlash(false);
        shakeScreen();
        if (navigator.vibrate) navigator.vibrate(150);
    }

    document.querySelectorAll('#soloOptionsBox .option').forEach((opt, i) => {
        opt.onclick = null;
        if (i === soloCurrentQuestion.correct) { opt.classList.add('correct'); animateCorrectOption(opt); }
        else if (i === idx && !correct) opt.classList.add('incorrect');
    });

    showSoloMessage(correct ? t('correct') : `${t('wrong')} ${soloCurrentQuestion.options[soloCurrentQuestion.correct]}`);
    soloQuestionIndex++;
    setTimeout(showNextSoloQuestion, 2500);
}

function handleSoloTimeout() {
    // Penalty for timeout (same as wrong answer)
    soloScore = Math.max(0, soloScore - WRONG_ANSWER_PENALTY);
    
    playSfx('wrong');
    
    // Update score display
    const scoreEl = document.getElementById('soloScore');
    if (scoreEl) {
        const scoreValue = scoreEl.querySelector('.score-value');
        if (scoreValue) {
            scoreValue.textContent = soloScore;
        }
    }
    
    showPointsPopup(`-${WRONG_ANSWER_PENALTY}`, false);
    showFeedbackFlash(false);
    shakeScreen();
    document.querySelectorAll('#soloOptionsBox .option').forEach((opt, i) => {
        opt.onclick = null;
        if (i === soloCurrentQuestion.correct) { opt.classList.add('correct'); animateCorrectOption(opt); }
    });
    showSoloMessage(`⏰ ${t('wrong')} ${soloCurrentQuestion.options[soloCurrentQuestion.correct]}`);
    soloQuestionIndex++;
    setTimeout(showNextSoloQuestion, 2500);
}

function showSoloGameOver() {
    clearInterval(timerInterval);
    
    // Save stats to Supabase if logged in
    if (currentPlayer) {
        // In solo mode, consider it a "win" if score is positive
        const didWin = soloScore > 0;
        updatePlayerStats(soloScore, didWin, 1);
        console.log(`[Solo] Stats saved: Score=${soloScore}, Won=${didWin}`);
    }
    
    // Show podium celebration for solo mode
    showPodiumCelebration([{
        name: document.getElementById('soloName')?.value || 'Player',
        score: soloScore
    }], true);
}

// Enhanced feedback functions
function showPointsPopup(text, isCorrect) {
    const popup = document.createElement('div');
    popup.className = `points-popup ${isCorrect ? 'correct' : 'wrong'}`;
    popup.textContent = text;
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 1500);
}

function showFeedbackFlash(isCorrect) {
    const overlay = document.createElement('div');
    overlay.className = `feedback-overlay ${isCorrect ? 'feedback-correct' : 'feedback-wrong'}`;
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 600);
}

// Podium Celebration with Avatars
function showPodiumCelebration(players, isSolo = false) {
    // Sort by score
    const sorted = [...players].sort((a, b) => b.score - a.score);
    
    // Store mode for the close function
    window.podiumIsSolo = isSolo;
    
    // Get avatars for players
    const gamePlayers = window.currentGamePlayers || [];
    const currentPlayerName = document.getElementById('createName')?.value || 
                              document.getElementById('joinName')?.value || '';
    
    function getPlayerAvatar(name) {
        const serverPlayer = gamePlayers.find(p => p.name === name);
        if (serverPlayer && serverPlayer.avatar) {
            return generateAvatarUrl(serverPlayer.avatar);
        } else if (name === currentPlayerName && currentAvatar) {
            return generateAvatarUrl(currentAvatar);
        } else {
            return generateAvatarUrlFromName(name);
        }
    }
    
    const overlay = document.createElement('div');
    overlay.className = 'podium-overlay';
    overlay.innerHTML = `
        <div class="podium-title">🏆 ${isSolo ? t('gameOver') : t('finalResults')} 🏆</div>
        <div class="podium-container">
            ${sorted.length > 1 ? `
            <div class="podium-place second" style="animation-delay: 0.3s;">
                <div class="podium-avatar">
                    <img src="${getPlayerAvatar(sorted[1]?.name)}" alt="${sorted[1]?.name || ''}">
                    <span class="podium-medal">🥈</span>
                </div>
                <div class="podium-name">${sorted[1]?.name || '-'}</div>
                <div class="podium-score">${sorted[1]?.score || 0} pts</div>
                <div class="podium-stand second-stand">2</div>
            </div>
            ` : ''}
            <div class="podium-place first" style="animation-delay: 0.6s;">
                <div class="podium-avatar">
                    <img src="${getPlayerAvatar(sorted[0]?.name)}" alt="${sorted[0]?.name || ''}">
                    <span class="podium-medal">🥇</span>
                </div>
                <div class="podium-name">${sorted[0]?.name || '-'}</div>
                <div class="podium-score">${sorted[0]?.score || 0} pts</div>
                <div class="podium-stand first-stand">1</div>
            </div>
            ${sorted.length > 2 ? `
            <div class="podium-place third" style="animation-delay: 0.9s;">
                <div class="podium-avatar">
                    <img src="${getPlayerAvatar(sorted[2]?.name)}" alt="${sorted[2]?.name || ''}">
                    <span class="podium-medal">🥉</span>
                </div>
                <div class="podium-name">${sorted[2]?.name || '-'}</div>
                <div class="podium-score">${sorted[2]?.score || 0} pts</div>
                <div class="podium-stand third-stand">3</div>
            </div>
            ` : ''}
        </div>
        <button class="btn podium-btn" onclick="closePodium()">${t('continue')}</button>
    `;
    
    document.body.appendChild(overlay);
    
    // Animate podium places
    setTimeout(() => {
        overlay.querySelectorAll('.podium-place').forEach((place, i) => {
            setTimeout(() => place.classList.add('animate-in'), i * 300);
        });
    }, 100);
    
    // Confetti celebration — double burst
    playSfx('victory');
    celebrateVictory();
    createConfetti(100);
    setTimeout(() => createConfetti(60), 800);
    // Haptic feedback on mobile
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
}

function closePodium() {
    const overlay = document.querySelector('.podium-overlay');
    if (overlay) overlay.remove();
    
    if (window.podiumIsSolo) {
        // Solo: just go back to home screen — no game over screen needed
        showScreen('homeScreen');
        updateAllAvatarDisplays();
    } else {
        // Multiplayer: show game over screen with leaderboard + rematch button
        closePodiumAndShowMultiGameOver();
    }
}

// Animated Leaderboard
function showAnimatedLeaderboard(scores, duration = 3000) {
    showClubhouseScoreboard(scores, null, null, null, duration);
}

// ============================================
// CLUBHOUSE SCOREBOARD — after each question
// ============================================
let _prevScores = {};

function showClubhouseScoreboard(scores, message, round, maxRounds, duration = 3500) {
    const sorted = Object.entries(scores)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);
    
    const myName = document.getElementById('createName')?.value || document.getElementById('joinName')?.value || '';
    const gamePlayers = window.currentGamePlayers || [];
    
    const getAvatar = (name) => {
        const p = gamePlayers.find(x => x.name === name);
        if (p && p.avatar && typeof generateAvatarUrl === 'function') return generateAvatarUrl(p.avatar);
        if (name === myName && typeof currentAvatar !== 'undefined' && currentAvatar && typeof generateAvatarUrl === 'function') return generateAvatarUrl(currentAvatar);
        if (typeof generateAvatarUrlFromName === 'function') return generateAvatarUrlFromName(name);
        return '';
    };

    const subtitle = message || (round ? `Round ${round}${maxRounds ? '/' + maxRounds : ''} Complete` : 'Standings');

    const overlay = document.createElement('div');
    overlay.className = 'ch-scoreboard-overlay';
    overlay.innerHTML = `
        <div class="ch-scoreboard">
            <div class="ch-scoreboard-header">
                <div class="ch-scoreboard-title">📊 Leaderboard</div>
                <div class="ch-scoreboard-subtitle">${subtitle}</div>
            </div>
            <div class="ch-scoreboard-list">
                ${sorted.map((p, i) => {
                    const prev = _prevScores[p.name] || 0;
                    const diff = p.score - prev;
                    const diffClass = diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral';
                    const diffText = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '—';
                    const avatarUrl = getAvatar(p.name);
                    const isMe = p.name === myName;
                    return `
                        <div class="ch-sb-row rank-${i + 1}" style="transition-delay: ${i * 0.1}s;">
                            <div class="ch-sb-rank">${i + 1}</div>
                            <div class="ch-sb-avatar">${avatarUrl ? `<img src="${avatarUrl}" alt="">` : '<span style="font-size:20px;">👤</span>'}</div>
                            <div class="ch-sb-info">
                                <div class="ch-sb-name">${p.name}${isMe ? '<span class="ch-sb-you">(you)</span>' : ''}</div>
                            </div>
                            <div class="ch-sb-right">
                                <div class="ch-sb-score">${p.score}</div>
                                <div class="ch-sb-change ${diffClass}">${diffText}</div>
                            </div>
                        </div>`;
                }).join('')}
            </div>
        </div>`;
    
    document.body.appendChild(overlay);
    
    // Stagger row reveals with GSAP
    setTimeout(() => {
        const rows = overlay.querySelectorAll('.ch-sb-row');
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(rows,
                { x: -30, opacity: 0 },
                { x: 0, opacity: 1, duration: 0.4, stagger: 0.1, ease: 'power3.out' }
            );
        } else {
            rows.forEach((row, i) => {
                setTimeout(() => row.classList.add('visible'), i * 120);
            });
        }
    }, 200);
    
    // Store scores for next diff
    _prevScores = { ...scores };
    
    // Auto-close
    setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    }, duration);
    
    // Click to dismiss
    overlay.addEventListener('click', () => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 300);
    });

    updateScores(scores);
}

// ============================================
// ELIMINATION OVERLAY — Clubhouse Style
// ============================================
function showEliminationOverlay(data) {
    updateScores(data.scores);
    
    const myName = document.getElementById('createName')?.value || document.getElementById('joinName')?.value || '';
    const isMe = data.player === myName;
    const gamePlayers = window.currentGamePlayers || [];
    
    const getAvatar = (name) => {
        const p = gamePlayers.find(x => x.name === name);
        if (p && p.avatar && typeof generateAvatarUrl === 'function') return generateAvatarUrl(p.avatar);
        if (typeof generateAvatarUrlFromName === 'function') return generateAvatarUrlFromName(name);
        return '';
    };
    
    const avatarUrl = getAvatar(data.player);
    const activePlayers = data.activePlayers || [];
    
    // Disable buzzer if it's me
    if (isMe) {
        const b = document.getElementById('buzzer');
        if (b) { b.disabled = true; const bt = b.querySelector('.buzzer__text'); if(bt) bt.textContent = 'ELIMINATED'; }
        shakeScreen();
    }
    
    const overlay = document.createElement('div');
    overlay.className = `ch-elimination-overlay ${isMe ? 'ch-elim-self' : ''}`;
    overlay.innerHTML = `
        <div class="ch-elim-card">
            <div class="ch-elim-skull">${isMe ? '😵' : '💀'}</div>
            <div class="ch-elim-title">${isMe ? 'You\'re Out!' : 'Eliminated!'}</div>
            <div class="ch-elim-avatar">${avatarUrl ? `<img src="${avatarUrl}" alt="${data.player}">` : '<span style="font-size:36px;">👤</span>'}</div>
            <div class="ch-elim-name">${data.player}</div>
            <div class="ch-elim-score">${data.score} pts</div>
            ${activePlayers.length > 0 ? `
                <div class="ch-elim-remaining">
                    <strong>${activePlayers.length}</strong> player${activePlayers.length !== 1 ? 's' : ''} remaining
                </div>` : ''}
        </div>`;
    
    document.body.appendChild(overlay);
    
    // GSAP entrance animation
    if (typeof gsap !== 'undefined') {
        const card = overlay.querySelector('.ch-elim-card');
        gsap.fromTo(overlay, { opacity: 0 }, { opacity: 1, duration: 0.3 });
        if (card) gsap.fromTo(card, { y: 50, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, delay: 0.15, ease: 'back.out(1.7)' });
    }
    
    // Play elimination sound
    playSfx('wrong');
    
    // Auto-close after 3.5 seconds
    setTimeout(() => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.4s ease';
        setTimeout(() => overlay.remove(), 400);
    }, 3500);
    
    // Click to dismiss early
    overlay.addEventListener('click', () => {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease';
        setTimeout(() => overlay.remove(), 300);
    });
}

// Question Transition with "Get Ready"
function showQuestionTransition(questionNum, callback) {
    const overlay = document.createElement('div');
    overlay.className = 'get-ready-overlay';
    overlay.innerHTML = `
        <div class="get-ready-text">${t('question').toUpperCase()} ${questionNum}</div>
        <div class="countdown-number">3</div>
    `;
    document.body.appendChild(overlay);
    
    const countdownEl = overlay.querySelector('.countdown-number');
    let count = 3;
    
    const countdownInterval = setInterval(() => {
        count--;
        if (count > 0) {
            countdownEl.textContent = count;
            countdownEl.style.animation = 'none';
            void countdownEl.offsetWidth;
            countdownEl.style.animation = 'countdownPulse 1s ease-in-out';
        } else {
            clearInterval(countdownInterval);
            countdownEl.textContent = t('go');
            countdownEl.style.color = 'var(--success)';
            setTimeout(() => {
                overlay.remove();
                if (callback) callback();
            }, 500);
        }
    }, 1000);
}

function showSoloMessage(text) {
    const box = document.getElementById('soloMessageBox');
    if (box) { box.textContent = text; box.style.display = 'block'; }
}

function hideSoloMessage() {
    const box = document.getElementById('soloMessageBox');
    if (box) box.style.display = 'none';
}

// ============================================
// MULTIPLAYER GAME
// ============================================

async function createRoom() {
    const codeEl = document.getElementById('createCode');
    const nameEl = document.getElementById('createName');
    const code = codeEl?.value.trim().toUpperCase();
    const name = nameEl?.value.trim();
    const subjects = getSelectedSubjects('createSubjects');
    const customCategory = document.getElementById('customCategoryInputMulti')?.value.trim();
    
    // Validation
    if (!name) { nameEl?.focus(); nameEl?.classList.add('input-error'); setTimeout(() => nameEl?.classList.remove('input-error'), 1500); showMessage('⚠️ ' + t('alertName')); return; }
    if (!code) { codeEl?.focus(); codeEl?.classList.add('input-error'); setTimeout(() => codeEl?.classList.remove('input-error'), 1500); showMessage('⚠️ Entrez un code de salle'); return; }
    if (!customCategory && subjects.length === 0) { showMessage('⚠️ ' + t('alertSubjects')); return; }
    
    const launchBtn = document.querySelector('#createMultiScreen .setup-launch-btn');
    if (launchBtn) { launchBtn.disabled = true; launchBtn.textContent = '⏳ Création...'; }
    
    try {
        if (customCategory) {
            await createRoomWithAI(code, name, customCategory);
        } else if (subjects.length > 0) {
            currentRoomCode = code;
            gameMode = 'multiplayer';
            const isPublic = selectedRoomVisibility === 'public';
            connectWebSocket(code, name, true, subjects, selectedGameMode, isPublic, null, null, selectedQuizType.multi);
        }
    } finally {
        if (launchBtn) { launchBtn.disabled = false; launchBtn.textContent = '🚀 Créer & Rejoindre'; }
    }
}

async function createRoomWithAI(code, name, category, retryCount = 0) {
    const MAX_RETRIES = 5;
    
    // Show loading modal
    const loadingModal = document.getElementById('aiLoadingModal');
    const loadingCategory = document.getElementById('aiLoadingCategory');
    const loadingText = document.getElementById('aiLoadingText');
    
    if (loadingModal) loadingModal.style.display = 'flex';
    if (loadingCategory) loadingCategory.textContent = category;
    
    // Update loading text based on retry count
    if (loadingText) {
        if (retryCount === 0) {
            loadingText.innerHTML = `${t('aiLoadingText')} "<span id="aiLoadingCategory">${category}</span>"`;
        } else {
            loadingText.innerHTML = `${t('aiLoadingRetry')} ${retryCount}/${MAX_RETRIES} 🔄`;
        }
    }
    
    try {
        const response = await fetch('/api/generate-questions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category: category,
                count: 10,
                language: selectedLanguage
            })
        });
        
        const data = await response.json();
        
        if (data.success && data.questions && data.questions.length > 0) {
            // Hide loading modal
            if (loadingModal) loadingModal.style.display = 'none';
            
            // Store AI questions temporarily
            window.aiGeneratedQuestions = data.questions.map((q) => {
                const correctIndex = q.options.findIndex(opt => opt === q.answer);
                return {
                    q: q.question,
                    options: q.options,
                    correct: correctIndex >= 0 ? correctIndex : 0,
                    time: 15
                };
            });
            
            currentRoomCode = code;
            gameMode = 'multiplayer';
            const isPublic = selectedRoomVisibility === 'public';
            // Pass 'ai_custom' as subject to signal using AI questions
            // Parameters: code, name, isCreating, subjects, gm, isPublic, team, aiQuestions
            connectWebSocket(code, name, true, ['ai_custom'], selectedGameMode, isPublic, null, window.aiGeneratedQuestions, selectedQuizType.multi);
        } else if (data.retry && retryCount < MAX_RETRIES) {
            // Model is loading, auto-retry after delay
            console.log(`AI model loading, retry ${retryCount + 1}/${MAX_RETRIES}...`);
            setTimeout(() => createRoomWithAI(code, name, category, retryCount + 1), 3000);
        } else if (retryCount >= MAX_RETRIES) {
            // Max retries reached
            if (loadingModal) loadingModal.style.display = 'none';
            alert(t('aiErrorTimeout'));
        } else {
            if (loadingModal) loadingModal.style.display = 'none';
            alert(data.error || t('aiErrorGeneration'));
        }
    } catch (error) {
        console.error('Error generating AI questions:', error);
        if (retryCount < MAX_RETRIES) {
            console.log(`Network error, retry ${retryCount + 1}/${MAX_RETRIES}...`);
            setTimeout(() => createRoomWithAI(code, name, category, retryCount + 1), 3000);
        } else {
            if (loadingModal) loadingModal.style.display = 'none';
            alert(t('aiErrorConnection'));
        }
    }
}

async function checkRoomMode() {
    const code = document.getElementById('joinCode')?.value.trim().toUpperCase();
    if (!code || code.length < 3) {
        document.getElementById('teamSelectionDiv')?.style.setProperty('display', 'none');
        roomGameMode = null;
        return;
    }
    if (isCheckingRoom) return;
    isCheckingRoom = true;

    return new Promise((resolve) => {
        const tempWs = new WebSocket(getWebSocketUrl(code));
        let responseReceived = false;
        const timeout = setTimeout(() => { if (!responseReceived) { tempWs.close(); isCheckingRoom = false; resolve(null); } }, 3000);

        tempWs.onopen = () => tempWs.send(JSON.stringify({ action: 'getRoomInfo' }));
        tempWs.onmessage = (event) => {
            responseReceived = true;
            clearTimeout(timeout);
            const msg = JSON.parse(event.data);
            if (msg.event === 'roomInfo') {
                roomGameMode = msg.data.gameMode;
                const teamSelectionDiv = document.getElementById('teamSelectionDiv');
                if (msg.data.gameMode === 'team' && teamSelectionDiv) {
                    teamSelectionDiv.style.display = 'block';
                    selectedJoinTeam = null;
                    resetTeamButtonStyles();
                    if (msg.data.teamCounts) {
                        document.getElementById('redCount').textContent = `${msg.data.teamCounts.red}/2`;
                        document.getElementById('blueCount').textContent = `${msg.data.teamCounts.blue}/2`;
                        const redDiv = document.getElementById('joinTeamRed');
                        const blueDiv = document.getElementById('joinTeamBlue');
                        if (msg.data.teamCounts.red >= 2 && redDiv) { redDiv.style.opacity = '0.5'; redDiv.style.pointerEvents = 'none'; redDiv.classList.add('disabled'); }
                        if (msg.data.teamCounts.blue >= 2 && blueDiv) { blueDiv.style.opacity = '0.5'; blueDiv.style.pointerEvents = 'none'; blueDiv.classList.add('disabled'); }
                        if (msg.data.teamCounts.red >= 2 && msg.data.teamCounts.blue < 2) selectJoinTeam('blue');
                        else if (msg.data.teamCounts.blue >= 2 && msg.data.teamCounts.red < 2) selectJoinTeam('red');
                    }
                } else if (teamSelectionDiv) teamSelectionDiv.style.display = 'none';
                resolve(msg.data.gameMode);
            } else { roomGameMode = null; document.getElementById('teamSelectionDiv')?.style.setProperty('display', 'none'); resolve(null); }
            tempWs.close();
            isCheckingRoom = false;
        };
        tempWs.onerror = () => { responseReceived = true; clearTimeout(timeout); isCheckingRoom = false; resolve(null); };
        tempWs.onclose = () => { if (!responseReceived) { isCheckingRoom = false; resolve(null); } };
    });
}

async function joinRoom() {
    const code = document.getElementById('joinCode')?.value.trim().toUpperCase();
    const name = document.getElementById('joinName')?.value.trim();
    if (!code || !name) { alert(t('alertBothFields')); return; }
    if (roomGameMode === null && !isCheckingRoom) await checkRoomMode();
    if (isCheckingRoom) await new Promise(r => setTimeout(r, 500));
    if (roomGameMode === 'team' && !selectedJoinTeam) { alert(t('selectTeam')); return; }
    currentRoomCode = code;
    gameMode = 'multiplayer';
    connectWebSocket(code, name, false, [], 'ffa', false, selectedJoinTeam);
}

function connectWebSocket(code, playerName, isCreating, subjects, gm = 'ffa', isPublic = false, team = null, aiQuestions = null, quizType = 'classic') {
    // Disconnect from lobby when joining a room
    disconnectFromLobby();
    
    // Debug logging
    console.log('connectWebSocket called with:');
    console.log('- code:', code);
    console.log('- isCreating:', isCreating);
    console.log('- quizType:', quizType);
    console.log('- aiQuestions length:', aiQuestions ? aiQuestions.length : 0);
    
    // Get current avatar config to send to server
    const avatarConfig = currentAvatar || generateRandomAvatar();
    
    ws = new WebSocket(getWebSocketUrl(code));
    ws.onopen = () => {
        if (isCreating) {
            const createData = { 
                action: 'create', 
                language: selectedLanguage, 
                subjects: subjects, 
                gameMode: gm, 
                isPublic: isPublic,
                quizType: quizType
            };
            // Include AI questions if provided
            if (aiQuestions && aiQuestions.length > 0) {
                createData.aiQuestions = aiQuestions;
            }
            ws.send(JSON.stringify(createData));
            setTimeout(() => ws.send(JSON.stringify({ action: 'join', playerName: playerName, avatar: avatarConfig })), 100);
        } else ws.send(JSON.stringify({ action: 'join', playerName: playerName, team: team, avatar: avatarConfig }));
    };
    ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
    ws.onerror = () => {
        if (!isAttemptingReconnect) alert(t('connectionError'));
    };
    ws.onclose = () => {
        // Auto-reconnect if game was in progress
        if (userId && matchToken && currentRoomCode && !isAttemptingReconnect) {
            const activeScreen = document.querySelector('.screen.active');
            const inGame = activeScreen && ['gameScreen', 'lobbyScreen'].includes(activeScreen.id);
            if (inGame) {
                attemptReconnect();
            }
        }
    };
}

// ============================================
// RECONNECTION SUPPORT
// ============================================

let isAttemptingReconnect = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000; // ms between attempts

function showReconnectOverlay() {
    let overlay = document.getElementById('reconnectOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'reconnectOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Poppins,sans-serif;color:white;';
        overlay.innerHTML = `
            <div style="width:48px;height:48px;border:3px solid rgba(255,255,255,0.2);border-top:3px solid #fff;border-radius:50%;animation:spin 1s linear infinite;margin-bottom:20px;"></div>
            <div style="font-size:18px;font-weight:600;margin-bottom:8px;">Reconnecting...</div>
            <div id="reconnectStatus" style="font-size:13px;opacity:0.6;">Attempting to rejoin the game</div>
            <button onclick="cancelReconnect()" style="margin-top:24px;padding:10px 24px;background:transparent;border:1px solid rgba(255,255,255,0.3);color:white;cursor:pointer;font-size:13px;border-radius:4px;">Cancel</button>
        `;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
}

function hideReconnectOverlay() {
    const overlay = document.getElementById('reconnectOverlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelReconnect() {
    isAttemptingReconnect = false;
    reconnectAttempts = 0;
    hideReconnectOverlay();
    if (ws) { try { ws.close(); } catch(e) {} }
    showHome();
}

function attemptReconnect() {
    if (isAttemptingReconnect) return;
    isAttemptingReconnect = true;
    reconnectAttempts = 0;
    showReconnectOverlay();
    doReconnectAttempt();
}

function doReconnectAttempt() {
    if (!isAttemptingReconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        isAttemptingReconnect = false;
        hideReconnectOverlay();
        showMessage('Could not reconnect to the game.');
        showHome();
        return;
    }
    
    reconnectAttempts++;
    const statusEl = document.getElementById('reconnectStatus');
    if (statusEl) statusEl.textContent = `Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`;
    
    console.log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} to room ${currentRoomCode}`);
    
    ws = new WebSocket(getWebSocketUrl(currentRoomCode));
    ws.onopen = () => {
        // Send rejoin with stored credentials
        ws.send(JSON.stringify({
            action: 'rejoin',
            userId: userId,
            matchToken: matchToken
        }));
    };
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.event === 'rejoined') {
            // Success — restore state
            isAttemptingReconnect = false;
            reconnectAttempts = 0;
            hideReconnectOverlay();
            
            userId = msg.data.userId;
            matchToken = msg.data.matchToken;
            isHost = msg.data.isHost;
            myTeam = msg.data.team;
            if (msg.data.language) { selectedLanguage = msg.data.language; applyTranslations(); }
            
            showMessage('Reconnected!');
            
            // Navigate to correct screen based on game state
            if (msg.data.gameState === 'waiting' || msg.data.gameState === 'gameOver') {
                showScreen('lobbyScreen');
            } else {
                showScreen('gameScreen');
            }
            
            // Re-bind message handler for ongoing events
            ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
            ws.onclose = () => {
                if (userId && matchToken && currentRoomCode && !isAttemptingReconnect) {
                    const activeScreen = document.querySelector('.screen.active');
                    const inGame = activeScreen && ['gameScreen', 'lobbyScreen'].includes(activeScreen.id);
                    if (inGame) attemptReconnect();
                }
            };
            ws.onerror = () => {};
        } else if (msg.event === 'rejoinFailed' || msg.event === 'error') {
            console.log('Rejoin failed:', msg.data);
            ws.close();
            // Retry after delay
            setTimeout(doReconnectAttempt, RECONNECT_DELAY);
        } else {
            // Got a different event — might mean we're already in, handle normally
            handleMessage(msg);
        }
    };
    ws.onerror = () => {
        setTimeout(doReconnectAttempt, RECONNECT_DELAY);
    };
    ws.onclose = () => {
        if (isAttemptingReconnect) {
            setTimeout(doReconnectAttempt, RECONNECT_DELAY);
        }
    };
}

// ============================================
// REMATCH SUPPORT
// ============================================

function requestRematch() {
    if (ws?.readyState === WebSocket.OPEN && userId && matchToken) {
        ws.send(JSON.stringify({
            action: 'rematch',
            userId: userId,
            matchToken: matchToken
        }));
    }
}

function handleMessage(msg) {
    switch (msg.event) {
        case 'roomCreated': document.getElementById('roomCode').textContent = msg.data.code; break;
        case 'joined':
            userId = msg.data.userId; matchToken = msg.data.matchToken; isHost = msg.data.isHost; myTeam = msg.data.team;
            if (msg.data.language) { selectedLanguage = msg.data.language; applyTranslations(); }
            showScreen('lobbyScreen');
            document.getElementById('roomCode').textContent = currentRoomCode;
            startLobbyFunFacts();
            break;
        case 'players': 
            updatePlayers(msg.data); 
            // Store players with their avatars for game screen
            window.currentGamePlayers = msg.data.players;
            break;
        case 'gameStarting': 
            showMessage(msg.data.message || 'Game starting!'); 
            // Initialize player cards when game starts
            if (window.currentGamePlayers) {
                initializeGameScreen(window.currentGamePlayers, {});
            }
            setTimeout(() => showScreen('gameScreen'), 2000); 
            break;
        case 'question': 
            currentMultiQuestion = msg.data; 
            // Show countdown before first question of each round
            if (msg.data.questionInRound === 1) {
                showGameCountdown(() => showQuestion(msg.data));
            } else {
                showQuestion(msg.data);
            }
            break;
        case 'buzzed': handleBuzzed(msg.data); break;
        case 'answerResult': showResult(msg.data); break;
        case 'roundComplete': clearInterval(timerInterval); showClubhouseScoreboard(msg.data.scores, msg.data.message, msg.data.round, msg.data.maxRounds); if (msg.data.teamScores) updateTeamScores(msg.data.teamScores); break;
        case 'playerEliminated': showEliminationOverlay(msg.data); break;
        case 'teamEliminated': showMessage(`💀 ${msg.data.message}`); updateScores(msg.data.scores); if (msg.data.teamScores) updateTeamScores(msg.data.teamScores); if (msg.data.team === myTeam) { const b = document.getElementById('buzzer'); if (b) { b.disabled = true; const bt = b.querySelector('.buzzer__text'); if(bt) bt.textContent = 'ELIMINATED'; } } break;
        case 'roundTransition': showMessage(`🔥 ${msg.data.message}`); updateScores(msg.data.scores); if (msg.data.teamScores) updateTeamScores(msg.data.teamScores); break;
        case 'gameOver': showGameOver(msg.data); break;
        case 'reaction': handleReaction(msg.data); break;
        case 'playerDisconnected': showMessage(`⚡ ${msg.data.message}`); break;
        case 'playerReconnected': showMessage(`✅ ${msg.data.message}`); break;
        case 'rematchStarted':
            showMessage(msg.data.message || 'Rematch!');
            // Reset local game state
            clearInterval(timerInterval);
            currentMultiQuestion = null;
            // Update players and return to lobby
            updatePlayers(msg.data);
            window.currentGamePlayers = msg.data.players;
            showScreen('lobbyScreen');
            document.getElementById('roomCode').textContent = msg.data.roomCode || currentRoomCode;
            // Show/hide rematch button
            const remBtn = document.getElementById('rematchBtn');
            if (remBtn) remBtn.style.display = 'none';
            break;
        case 'error': alert(msg.data); break;
        case 'playerLeft': showMessage(msg.data.message || 'Player left'); break;
        case 'newHost': showMessage(msg.data.message || 'New host'); const myN2 = document.getElementById('createName')?.value || document.getElementById('joinName')?.value; if (msg.data.hostName === myN2) isHost = true; break;
    }
}

function updatePlayers(data) {
    const list = document.getElementById('playersList');
    if (!list) return;
    list.innerHTML = `<h3>${t('players')}</h3>`;
    if (data.gameMode === 'team' && data.teamCounts) {
        const td = document.createElement('div'); td.className = 'team-scores';
        td.innerHTML = `<div class="team-score-box red"><div>${t('teamRed')}</div><div style="font-size:20px;margin-top:5px;">${data.teamCounts.red}/2</div></div><div class="team-score-box blue"><div>${t('teamBlue')}</div><div style="font-size:20px;margin-top:5px;">${data.teamCounts.blue}/2</div></div>`;
        list.appendChild(td);
    }
    
    // Get current player name from input fields
    const currentPlayerName = document.getElementById('createName')?.value || 
                              document.getElementById('joinName')?.value || '';
    
    data.players.forEach(player => {
        const div = document.createElement('div'); div.className = 'player-item' + (player.isHost ? ' host' : '');
        let teamBadge = '';
        if (data.gameMode === 'team' && player.team) teamBadge = `<span class="team-badge team-${player.team}">${t('team' + player.team.charAt(0).toUpperCase() + player.team.slice(1))}</span>`;
        
        // Use avatar from server if available, otherwise generate from name
        let avatarUrl;
        if (player.avatar) {
            avatarUrl = generateAvatarUrl(player.avatar);
        } else {
            avatarUrl = generateAvatarUrlFromName(player.name);
        }
        
        div.innerHTML = `
            <div class="player-info">
                <img src="${avatarUrl}" alt="${player.name}" class="player-avatar">
                <span class="player-name">${player.name}${teamBadge}</span>
            </div>
            ${player.isHost ? `<span class="host-badge">${t('host')}</span>` : ''}
        `;
        // Add join animation
        div.classList.add('player-join-animation');
        list.appendChild(div);
    });
    
    // Update player count display and store for language changes
    currentLobbyPlayerCount = data.players.length;
    updateLobbyPlayerCount();
    
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.style.display = (isHost && data.canStart) ? 'block' : 'none';
}

function updateLobbyPlayerCount() {
    const waitingMsg = document.querySelector('.waiting-message');
    if (waitingMsg && currentLobbyPlayerCount > 0) {
        const countText = currentLobbyPlayerCount === 1 ? t('playerInLobby') : t('playersInLobby');
        waitingMsg.innerHTML = `<span class="lobby-player-count">${currentLobbyPlayerCount}</span> ${countText}<span class="lobby-waiting-dots">...</span>`;
    } else if (waitingMsg) {
        waitingMsg.textContent = t('waitingForPlayers');
    }
}

// Lobby fun facts rotation
const lobbyFunFacts = [
    "💡 Le saviez-vous ? Le quiz le plus ancien date de 1938 en Angleterre.",
    "🎯 Astuce : Répondez vite — les points diminuent avec le temps !",
    "🧠 Les joueurs qui buzzent en premier gagnent 2× plus de points en moyenne.",
    "🌍 Plus de 1000 questions dans 10+ catégories vous attendent.",
    "🤖 Tapez n'importe quel sujet — l'IA génère un quiz en secondes.",
    "⚡ Mode Speed Round : timer divisé par 2, adrénaline multipliée par 10.",
    "🏆 Le record actuel est détenu par quelqu'un dans cette salle... peut-être.",
    "🎮 Essayez le thème Horror pour une expérience terrifiante !",
];
let funFactInterval = null;

function startLobbyFunFacts() {
    clearInterval(funFactInterval);
    const el = document.querySelector('.lobby-fun-fact');
    if (!el) return;
    let idx = Math.floor(Math.random() * lobbyFunFacts.length);
    el.textContent = lobbyFunFacts[idx];
    el.style.opacity = '1';
    funFactInterval = setInterval(() => {
        el.style.opacity = '0';
        setTimeout(() => {
            idx = (idx + 1) % lobbyFunFacts.length;
            el.textContent = lobbyFunFacts[idx];
            el.style.opacity = '1';
        }, 400);
    }, 6000);
}

function stopLobbyFunFacts() { clearInterval(funFactInterval); }

function startGame() {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'start', userId, matchToken, language: selectedLanguage }));
}

let currentMaxTime = 10;

function showGameCountdown(callback) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.9);';
    const num = document.createElement('div');
    num.style.cssText = 'font-size:clamp(100px,25vw,200px);font-weight:900;color:var(--accent-1,#0ff);text-shadow:0 0 80px currentColor;font-family:var(--font-display,inherit);opacity:0;';
    overlay.appendChild(num);
    document.body.appendChild(overlay);
    
    const counts = ['3', '2', '1', 'GO!'];
    let i = 0;
    
    function showNext() {
        if (i >= counts.length) {
            if (typeof gsap !== 'undefined') {
                gsap.to(overlay, { opacity: 0, duration: 0.3, onComplete: () => { overlay.remove(); callback(); } });
            } else {
                overlay.style.opacity = '0'; overlay.style.transition = 'opacity 0.3s';
                setTimeout(() => { overlay.remove(); callback(); }, 300);
            }
            return;
        }
        
        num.textContent = counts[i];
        if (i === counts.length - 1) num.style.fontSize = 'clamp(80px,18vw,160px)';
        
        playSfx('countdown');
        
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(num, 
                { scale: 2.5, opacity: 0 },
                { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(1.7)',
                  onComplete: () => {
                      gsap.to(num, { scale: 0.8, opacity: 0, duration: 0.3, delay: 0.3, 
                          onComplete: () => { i++; showNext(); }
                      });
                  }
                }
            );
        } else {
            num.style.opacity = '1';
            num.style.animation = 'chBubbleIn 0.4s var(--ease-spring) both';
            setTimeout(() => { i++; showNext(); }, 800);
        }
    }
    
    showNext();
}

function showQuestion(data) {
    console.log('showQuestion called with:', data);
    
    // Ensure we're on the game screen
    const currentScreen = document.querySelector('.screen.active');
    const gameScreen = document.getElementById('gameScreen');
    if (currentScreen) currentScreen.classList.remove('active', 'exiting');
    if (gameScreen) gameScreen.classList.add('active');
    
    hasBuzzed = false; canAnswer = false;
    
    // Update question text
    const questionTextEl = document.getElementById('questionText');
    if (questionTextEl) questionTextEl.textContent = data.q;
    
    // Update question number
    const questionNumberEl = document.getElementById('questionNumber');
    if (questionNumberEl && data.questionInRound) {
        questionNumberEl.textContent = `QUESTION #${data.questionInRound}`;
    }
    
    // Handle question image
    const questionImageEl = document.getElementById('questionImage');
    if (questionImageEl) {
        if (data.image) {
            questionImageEl.style.display = 'block';
            questionImageEl.querySelector('img').src = data.image;
        } else {
            questionImageEl.style.display = 'none';
        }
    }
    
    // Animate question bubble in with GSAP
    const bubble = document.getElementById('questionBubble');
    if (bubble) {
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(bubble,
                { y: 40, opacity: 0, scale: 0.92 },
                { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.5)' }
            );
        } else {
            bubble.style.animation = 'none'; void bubble.offsetWidth;
            bubble.style.animation = 'chBubbleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both';
        }
    }
    
    // Update round badge
    const roundInfo = document.getElementById('roundInfo');
    if (roundInfo && data.round) {
        const roundValue = roundInfo.querySelector('.round-value');
        if (roundValue) roundValue.textContent = `${data.round}/3`;
    }
    
    // Update difficulty badge
    const diffBadge = document.getElementById('difficultyBadge');
    if (diffBadge && data.difficulty) {
        diffBadge.style.display = 'flex';
        diffBadge.dataset.level = data.difficulty;
        const diffIcon = document.getElementById('difficultyIcon');
        const diffText = document.getElementById('difficultyText');
        const diffMap = { easy: { icon: '🟢', text: 'Facile' }, medium: { icon: '🟡', text: 'Moyen' }, hard: { icon: '🔴', text: 'Difficile ×1.5' } };
        const d = diffMap[data.difficulty] || diffMap.medium;
        if (diffIcon) diffIcon.textContent = d.icon;
        if (diffText) diffText.textContent = d.text;
    }
    
    // Update question badge
    const questionBadge = document.getElementById('questionBadge');
    if (questionBadge && data.questionInRound) {
        const questionValue = questionBadge.querySelector('.question-value');
        if (questionValue) questionValue.textContent = `${data.questionInRound}/${data.questionsPerRound || 5}`;
    }

    // Timer
    let timeLeft = data.time || 10;
    currentMaxTime = data.time || 10;
    const timerValue = document.getElementById('timerValue');
    const timerChip = document.querySelector('.ch-timer-chip');
    if (timerValue) timerValue.textContent = timeLeft;
    if (timerChip) timerChip.classList.remove('urgent');

    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        if (timerValue) timerValue.textContent = Math.max(0, timeLeft);
        if (timerChip && timeLeft <= 3) timerChip.classList.add('urgent');
        if (timeLeft <= 0) clearInterval(timerInterval);
    }, 1000);

    // Show buzzer, hide options (staged reveal)
    const buzzerArea = document.getElementById('buzzerArea');
    const buzzer = document.getElementById('buzzer');
    if (buzzerArea) buzzerArea.style.display = 'flex';
    if (buzzer) { 
        buzzer.disabled = false; 
        buzzer.classList.remove('buzzed');
        const buzzerText = buzzer.querySelector('.ch-buzzer-text');
        if (buzzerText) buzzerText.textContent = t('buzz');
    }

    // Build options but keep hidden
    const optionsBox = document.getElementById('optionsBox');
    const quizType = data.quizType || 'classic';
    
    if (optionsBox && data.options) {
        optionsBox.innerHTML = '';
        optionsBox.style.display = 'none'; // Hidden until buzz
        
        if (quizType === 'truefalse') {
            // True/False: 2 big buttons side by side
            optionsBox.style.gridTemplateColumns = 'repeat(2, 1fr)';
            data.options.forEach((option, idx) => {
                const btn = document.createElement('button');
                btn.className = 'ch-option';
                btn.style.minHeight = '120px';
                btn.style.fontSize = '24px';
                btn.innerHTML = `${option === 'Vrai' ? '✅' : '❌'} ${option}`;
                btn.onclick = () => answerQuestion(idx);
                optionsBox.appendChild(btn);
            });
        } else {
            // Classic, speed, picguess — normal 2x2 grid
            optionsBox.style.gridTemplateColumns = 'repeat(2, 1fr)';
            const optionKeys = ['A', 'B', 'X', 'Y'];
            data.options.forEach((option, idx) => {
                const btn = document.createElement('button');
                btn.className = 'ch-option';
                btn.innerHTML = `<span class="ch-option-key">${optionKeys[idx] || idx + 1}</span>${option}`;
                btn.onclick = () => answerQuestion(idx);
                optionsBox.appendChild(btn);
            });
        }
    }
    
    // Picture Guess: progressive deblur on the question image
    if (quizType === 'picguess' && data.image) {
        const qImg = document.querySelector('#questionImage img');
        if (qImg) {
            const blurStart = data.blurStart || 20;
            qImg.style.filter = `blur(${blurStart}px)`;
            qImg.style.transition = 'filter linear';
            // Deblur over the question timer duration
            const deblurDuration = (data.time || 15) * 1000;
            qImg.style.transitionDuration = `${deblurDuration}ms`;
            // Trigger deblur on next frame
            requestAnimationFrame(() => {
                qImg.style.filter = 'blur(0px)';
            });
        }
    }
    
    hideMessage();
}

function buzzerPressed() {
    const buzzer = document.getElementById('buzzer');
    if (!buzzer || buzzer.disabled || hasBuzzed) return;
    hasBuzzed = true; buzzer.disabled = true; buzzer.classList.add('buzzed');
    const buzzerText = buzzer.querySelector('.buzzer__text');
    if (buzzerText) buzzerText.textContent = 'BUZZED!';
    playSfx('buzzer');
    if (navigator.vibrate) navigator.vibrate(80);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'buzz', userId, matchToken }));
}

function handleBuzzed(data) {
    const playerName = data.player || data;
    showMessage(`🔔 ${playerName} buzzed!`);
    playSfx('buzzer');
    
    const buzzer = document.getElementById('buzzer');
    if (buzzer) { 
        buzzer.disabled = true; 
        buzzer.classList.add('buzzed');
        const buzzerText = buzzer.querySelector('.buzzer__text');
        if (buzzerText) buzzerText.textContent = `${playerName} BUZZED!`;
    }
    
    const myName = document.getElementById('createName')?.value || document.getElementById('joinName')?.value;
    if (playerName === myName) { 
        canAnswer = true;
    }

    // STAGED REVEAL: Hide buzzer area, show options with animation
    const buzzerArea = document.getElementById('buzzerArea');
    if (buzzerArea) {
        if (typeof gsap !== 'undefined') {
            gsap.to(buzzerArea, { scale: 0.8, opacity: 0, duration: 0.25, ease: 'power2.in',
                onComplete: () => { buzzerArea.style.display = 'none'; }
            });
        } else {
            buzzerArea.style.display = 'none';
        }
    }
    
    const optionsBox = document.getElementById('optionsBox');
    if (optionsBox) {
        optionsBox.style.display = 'grid';
        const opts = optionsBox.querySelectorAll('.ch-option');
        
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(opts, 
                { y: 30, opacity: 0, scale: 0.9 },
                { y: 0, opacity: 1, scale: 1, duration: 0.4, stagger: 0.08, ease: 'back.out(1.4)', delay: 0.2 }
            );
        } else {
            opts.forEach((opt, i) => {
                opt.style.animation = 'none'; void opt.offsetWidth;
                opt.style.animation = `chOptionIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) ${i * 0.07}s both`;
            });
        }
    }
    
    // Highlight the player who buzzed
    highlightBuzzedPlayer(playerName);
}

function highlightBuzzedPlayer(playerName) {
    document.querySelectorAll('.ch-player-card').forEach(card => {
        card.classList.remove('buzzed-highlight');
        const nameEl = card.querySelector('.ch-player-name');
        if (nameEl && nameEl.textContent === playerName) {
            card.classList.add('buzzed-highlight');
        }
    });
}

function answerQuestion(idx) {
    if (!canAnswer) return;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'answer', userId, matchToken, idx }));
    document.querySelectorAll('#optionsBox .option, #optionsBox .ch-option').forEach(opt => opt.onclick = null);
    canAnswer = false;
}

function showResult(data) {
    clearInterval(timerInterval);
    
    // Make sure options are visible for result reveal
    const optionsBox = document.getElementById('optionsBox');
    if (optionsBox) optionsBox.style.display = 'grid';
    
    document.querySelectorAll('#optionsBox .ch-option').forEach((opt, idx) => {
        opt.onclick = null;
        // Mark correct answer
        if (opt.textContent.replace(/^[ABXY]/, '').trim() === data.answer || 
            opt.textContent.includes(data.answer)) { 
            opt.classList.add('correct'); 
        }
        // Mark incorrect selected answer
        if (!data.correct && data.selectedIdx !== undefined && idx === data.selectedIdx) {
            opt.classList.add('wrong');
        }
    });
    
    const myName = document.getElementById('createName')?.value || document.getElementById('joinName')?.value;
    if (data.answeredBy === myName || (data.timeout && data.pointsEarned)) { 
        const pointsEarned = data.pointsEarned || 0;
        
        if (data.correct) { 
            playSfx('correct');
            showPointsPopup(`+${pointsEarned}`, true);
            showFeedbackFlash(true);
            createConfetti(30); 
        } else { 
            playSfx('wrong');
            
            // Horror theme: trigger jumpscare on wrong answer (30% chance)
            if (selectedTheme === 'horror' && Math.random() > 0.7) {
                triggerHorrorJumpscare();
            }
            
            showPointsPopup(pointsEarned < 0 ? `${pointsEarned}` : '✗', false);
            showFeedbackFlash(false);
            shakeScreen(); 
        } 
    }
    updateScores(data.scores);
    if (data.teamScores) updateTeamScores(data.teamScores);
    showMessage(data.message || (data.correct ? t('correct') : `${t('wrong')} ${data.answer}`));
    
    // Show animated leaderboard after a delay
    setTimeout(() => {
        showAnimatedLeaderboard(data.scores, 2500);
    }, 1000);
}

function updateScores(scores) {
    const scoresBox = document.getElementById('scoresBox');
    if (!scoresBox) return;
    const teamDiv = document.getElementById('teamScoresDiv');
    scoresBox.innerHTML = `<h3>${t('scores')}</h3>`;
    if (teamDiv) scoresBox.insertBefore(teamDiv, scoresBox.firstChild);
    
    // Find max score for progress bars
    const maxScore = Math.max(...Object.values(scores), 1);
    
    Object.entries(scores).forEach(([name, score]) => {
        const div = document.createElement('div'); 
        div.className = 'score-row';
        const avatar = createAvatarHTML(name);
        const percentage = Math.max(0, (score / maxScore) * 100);
        
        div.innerHTML = `
            <div class="player-info">
                ${avatar}
                <span class="player-name">${name}</span>
            </div>
            <div class="player-score-container">
                <div class="player-score-bar">
                    <div class="player-score-fill" style="width: ${percentage}%"></div>
                </div>
                <span class="player-score-text ${score < 0 ? 'negative' : ''}">${score}</span>
            </div>
        `;
        scoresBox.appendChild(div);
    });
    
    // Also update player cards on game screen
    updatePlayerCardsScores(scores);
}

function updateTeamScores(teamScores) {
    const scoresBox = document.getElementById('scoresBox');
    if (!scoresBox) return;
    let teamDiv = document.getElementById('teamScoresDiv');
    if (!teamDiv) { teamDiv = document.createElement('div'); teamDiv.id = 'teamScoresDiv'; teamDiv.className = 'team-scores'; scoresBox.insertBefore(teamDiv, scoresBox.firstChild); }
    teamDiv.innerHTML = `<div class="team-score-box red ${!teamScores.red.active ? 'eliminated' : ''}"><div>${t('teamRed')}</div><div style="font-size:24px;margin-top:5px;">${teamScores.red.score}</div>${!teamScores.red.active ? '<div style="font-size:10px;">ELIMINATED</div>' : ''}</div><div class="team-score-box blue ${!teamScores.blue.active ? 'eliminated' : ''}"><div>${t('teamBlue')}</div><div style="font-size:24px;margin-top:5px;">${teamScores.blue.score}</div>${!teamScores.blue.active ? '<div style="font-size:10px;">ELIMINATED</div>' : ''}</div>`;
}

// Player card colors for clubhouse style
const playerCardColors = ['pink', 'blue', 'yellow', 'green'];

// Render player cards on game screen - Horizontal layout at top
// Update player card scores
function updatePlayerCardsScores(scores) {
    // Update Clubhouse floating player cards
    document.querySelectorAll('.ch-player-card').forEach(card => {
        const nameEl = card.querySelector('.ch-player-name');
        if (!nameEl) return;
        // Strip host crown emoji for matching
        const name = nameEl.textContent.replace(' 👑', '').trim();
        if (name && scores[name] !== undefined) {
            const scoreEl = card.querySelector('.ch-player-score');
            if (scoreEl) {
                scoreEl.textContent = `${scores[name]} pts`;
                scoreEl.style.animation = 'none';
                void scoreEl.offsetWidth;
                scoreEl.style.animation = 'chScoreBounce 0.4s ease';
            }
        }
    });
}

function showScorePopup(points) {
    const popup = document.createElement('div');
    popup.className = `ch-score-popup ${points >= 0 ? 'positive' : 'negative'}`;
    popup.textContent = points >= 0 ? `+${points}` : `${points}`;
    popup.style.left = '50%';
    popup.style.top = '45%';
    popup.style.transform = 'translateX(-50%)';
    document.body.appendChild(popup);
    setTimeout(() => popup.remove(), 1300);
}

// Initialize player cards when game starts
function initializeGameScreen(players, scores = {}) {
    renderClubhousePlayers(players, scores);
    
    // Reset UI elements
    const buzzerArea = document.getElementById('buzzerArea');
    const buzzer = document.getElementById('buzzer');
    if (buzzerArea) buzzerArea.style.display = 'flex';
    if (buzzer) {
        buzzer.disabled = false;
        buzzer.classList.remove('buzzed');
        const buzzerText = buzzer.querySelector('.ch-buzzer-text');
        if (buzzerText) buzzerText.textContent = t('buzz');
    }
    
    const optionsBox = document.getElementById('optionsBox');
    if (optionsBox) optionsBox.style.display = 'none';
}

function renderClubhousePlayers(players, scores = {}) {
    const layer = document.getElementById('chPlayersLayer');
    if (!layer) return;
    layer.innerHTML = '';
    
    const gamePlayers = players || window.currentGamePlayers || [];
    
    gamePlayers.forEach((player, idx) => {
        const card = document.createElement('div');
        card.className = 'ch-player-card';
        
        // Get avatar URL
        let avatarHTML = '';
        if (player.avatar) {
            const url = typeof generateAvatarUrl === 'function' ? generateAvatarUrl(player.avatar) : '';
            avatarHTML = url ? `<img src="${url}" alt="${player.name}">` : `<span style="font-size:40px;">👤</span>`;
        } else {
            avatarHTML = `<span style="font-size:40px;">👤</span>`;
        }
        
        const score = scores[player.name] || player.score || 0;
        
        card.innerHTML = `
            <div class="ch-player-avatar">${avatarHTML}</div>
            <div class="ch-player-nametag">
                <div class="ch-player-name">${player.name}${player.isHost ? ' 👑' : ''}</div>
                <div class="ch-player-score">${score} pts</div>
            </div>
        `;
        
        layer.appendChild(card);
    });
}

function showGameOver(data) {
    clearInterval(timerInterval);
    
    // Convert finalScores to array for podium
    const players = Object.entries(data.finalScores)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);
    
    // Show podium celebration first
    showPodiumCelebration(players, false);
    
    // Store data for later use in closePodiumAndShowMultiGameOver
    window.multiGameOverData = data;
}

function closePodiumAndShowMultiGameOver() {
    const overlay = document.querySelector('.podium-overlay');
    if (overlay) overlay.remove();
    
    const data = window.multiGameOverData;
    if (!data) {
        showScreen('homeScreen');
        return;
    }
    
    // Use direct DOM manipulation instead of showScreen to avoid timing issues
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'exiting'));
    const goScreen = document.getElementById('gameOverScreen');
    if (goScreen) goScreen.classList.add('active');
    
    // Set rematch button AFTER screen is active
    const rematchBtn = document.getElementById('rematchBtn');
    console.log('[Rematch] isHost:', isHost, 'userId:', userId, 'ws open:', ws?.readyState === WebSocket.OPEN);
    if (rematchBtn) {
        if (isHost) {
            rematchBtn.style.display = 'inline-flex';
            rematchBtn.textContent = '🔄 Rematch';
        } else {
            rematchBtn.style.display = 'inline-flex';
            rematchBtn.textContent = '⏳ Waiting for host...';
            rematchBtn.disabled = true;
            rematchBtn.style.opacity = '0.5';
            rematchBtn.style.cursor = 'default';
        }
    }
    
    // Update winner announcement
    const winnerBox = document.getElementById('winnerBox');
    if (winnerBox) {
        const winnerName = winnerBox.querySelector('.winner-name');
        if (winnerName) {
            winnerName.textContent = data.winner ? `${data.winner} wins!` : (data.reason || 'Game Over!');
        }
    }
    
    // Sort players by score
    const sortedPlayers = Object.entries(data.finalScores)
        .map(([name, score]) => ({ name, score }))
        .sort((a, b) => b.score - a.score);
    
    const currentPlayerName = document.getElementById('createName')?.value || 
                              document.getElementById('joinName')?.value || '';
    
    // ========================================
    // SAVE STATS TO SUPABASE FOR MULTIPLAYER
    // ========================================
    if (currentPlayer && currentPlayerName) {
        // Find current player's score and position
        const playerIndex = sortedPlayers.findIndex(p => p.name === currentPlayerName);
        if (playerIndex !== -1) {
            const myScore = sortedPlayers[playerIndex].score;
            const myPosition = playerIndex + 1;
            const didWin = myPosition === 1;
            const playersCount = sortedPlayers.length;
            
            // Update stats in Supabase (with position)
            updatePlayerStats(myScore, didWin, playersCount, myPosition);
            
            console.log(`[Multiplayer] Stats saved: Score=${myScore}, Position=${myPosition}/${playersCount}, Won=${didWin}`);
        }
    }
    
    // Get player avatars from stored game players
    const gamePlayers = window.currentGamePlayers || [];
    const getPlayerAvatar = (playerName) => {
        const player = gamePlayers.find(p => p.name === playerName);
        if (player && player.avatar) {
            return generateAvatarUrl(player.avatar);
        }
        // Fallback: check if it's current player
        if (playerName === currentPlayerName && currentAvatar) {
            return generateAvatarUrl(currentAvatar);
        }
        return generateAvatarUrlFromName(playerName);
    };
    
    // Render podium with avatars
    const podiumContainer = document.getElementById('podiumClubhouse');
    if (podiumContainer && sortedPlayers.length >= 1) {
        let podiumHTML = '';
        
        // Top 3 for podium
        const podiumPlayers = sortedPlayers.slice(0, 3);
        const positions = ['first', 'second', 'third'];
        const medals = ['🥇', '🥈', '🥉'];
        
        podiumPlayers.forEach((player, idx) => {
            const avatarUrl = getPlayerAvatar(player.name);
            
            podiumHTML += `
                <div class="podium-place-clubhouse ${positions[idx]}">
                    <div class="podium-avatar-frame">
                        <img src="${avatarUrl}" alt="${player.name}">
                    </div>
                    <div class="podium-player-name">${player.name}</div>
                    <div class="podium-player-score">${player.score} pts</div>
                    <div class="podium-stand">${idx + 1}</div>
                </div>
            `;
        });
        
        podiumContainer.innerHTML = podiumHTML;
    }
    
    // Render leaderboard with avatars
    const leaderboardList = document.getElementById('leaderboardList');
    if (leaderboardList) {
        leaderboardList.innerHTML = sortedPlayers.map((player, idx) => {
            const avatarUrl = getPlayerAvatar(player.name);
            
            return `
                <div class="leaderboard-item">
                    <div class="leaderboard-rank">${idx + 1}</div>
                    <div class="leaderboard-avatar">
                        <img src="${avatarUrl}" alt="${player.name}">
                    </div>
                    <div class="leaderboard-name">${player.name}</div>
                    <div class="leaderboard-score">${player.score} pts</div>
                </div>
            `;
        }).join('');
    }
    
    // Trigger celebration
    createConfetti(80);
}

function showMessage(text) { const box = document.getElementById('messageBox'); if (box) { box.textContent = text; box.classList.add('visible'); box.style.display = 'block'; setTimeout(() => { box.classList.remove('visible'); }, 3000); } }
function hideMessage() { const box = document.getElementById('messageBox'); if (box) { box.classList.remove('visible'); box.style.display = 'none'; } }

// ============================================
// VISUAL EFFECTS
// ============================================

function createConfetti(count = 50) {
    if (typeof confetti !== 'function') return;
    const themeColors = {
        neon: ['#0ff', '#f0f', '#0f0', '#ff0'],
        dragon: ['#ff6b35', '#c41e3a', '#ffd700', '#fff'],
        horror: ['#cc0000', '#8B0000', '#ff4444', '#fff'],
        sakura: ['#ffb7c5', '#ff69b4', '#fff0f5', '#ff1493'],
        midnight: ['#e94560', '#533a7b', '#ffc857', '#fff'],
        clean: ['#4361ee', '#3a0ca3', '#7209b7', '#fff']
    };
    const colors = themeColors[selectedTheme] || themeColors.neon;
    
    // Burst from both sides
    confetti({ particleCount: Math.floor(count / 2), angle: 60, spread: 55, origin: { x: 0, y: 0.6 }, colors });
    confetti({ particleCount: Math.floor(count / 2), angle: 120, spread: 55, origin: { x: 1, y: 0.6 }, colors });
}

function celebrateVictory() {
    if (typeof confetti !== 'function') return;
    const themeColors = {
        neon: ['#0ff', '#f0f', '#0f0'], dragon: ['#ff6b35', '#ffd700'], sakura: ['#ffb7c5', '#ff69b4'],
        midnight: ['#e94560', '#ffc857'], clean: ['#4361ee', '#7209b7'], horror: ['#cc0000', '#ff4444']
    };
    const colors = themeColors[selectedTheme] || ['#0ff', '#f0f', '#ff0'];
    
    // Big celebration — 3 staggered bursts
    const duration = 2000;
    const end = Date.now() + duration;
    (function frame() {
        confetti({ particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: Math.random() * 0.4 + 0.3 }, colors });
        confetti({ particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: Math.random() * 0.4 + 0.3 }, colors });
        if (Date.now() < end) requestAnimationFrame(frame);
    })();
    
    const wb = document.getElementById('winnerBox');
    if (wb) wb.classList.add('victory-animate');
}

function shakeScreen() { const c = document.querySelector('.screen.active'); if (c) { c.classList.add('shake'); setTimeout(() => c.classList.remove('shake'), 500); } }
function flashWrong() { const c = document.querySelector('.screen.active'); if (c) { c.classList.add('wrong-flash'); setTimeout(() => c.classList.remove('wrong-flash'), 500); } }
function animateScore(id) { const el = document.getElementById(id); if (el) { el.classList.add('score-animate'); setTimeout(() => el.classList.remove('score-animate'), 500); } }
function animateCorrectOption(el) { if (el) { el.classList.add('correct-pulse'); setTimeout(() => el.classList.remove('correct-pulse'), 600); } }

// ============================================
// UI IMPROVEMENTS
// ============================================

// Button ripple effect
document.addEventListener('click', function(e) {
    const btn = e.target.closest('.btn');
    if (btn) {
        const rect = btn.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        btn.style.setProperty('--ripple-x', x + '%');
        btn.style.setProperty('--ripple-y', y + '%');
        btn.classList.remove('ripple');
        void btn.offsetWidth; // Trigger reflow
        btn.classList.add('ripple');
        setTimeout(() => btn.classList.remove('ripple'), 600);
    }
});

// Generate avatar color from name
function getAvatarColor(name) {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
        '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
        '#F8B500', '#FF6F61', '#6B5B95', '#88B04B', '#F7CAC9',
        '#92A8D1', '#955251', '#B565A7', '#009B77', '#DD4124'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// Get initials from name
function getInitials(name) {
    return name.split(' ')
        .map(word => word.charAt(0))
        .join('')
        .substring(0, 2)
        .toUpperCase();
}

// Create avatar HTML with DiceBear
function createAvatarHTML(name, isCurrentPlayer = false) {
    let avatarUrl;
    if (isCurrentPlayer && currentAvatar) {
        avatarUrl = generateAvatarUrl(currentAvatar);
    } else {
        avatarUrl = generateAvatarUrlFromName(name);
    }
    return `<div class="player-avatar"><img src="${avatarUrl}" alt="${name}" class="player-avatar-img"></div>`;
}

// Create circular timer HTML
function createCircularTimer(time, maxTime) {
    const percentage = (time / maxTime);
    const circumference = 226; // 2 * PI * 36 (radius)
    const offset = circumference * (1 - percentage);
    
    let colorClass = '';
    if (percentage <= 0.25) colorClass = 'danger';
    else if (percentage <= 0.5) colorClass = 'warning';
    
    return `
        <div class="timer-container">
            <div class="circular-timer">
                <svg viewBox="0 0 80 80">
                    <circle class="timer-bg" cx="40" cy="40" r="36"/>
                    <circle class="timer-progress ${colorClass}" cx="40" cy="40" r="36" 
                        style="stroke-dashoffset: ${offset}"/>
                </svg>
                <span class="timer-text ${colorClass}">${time}</span>
            </div>
        </div>
    `;
}

// Update circular timer
function updateCircularTimer(containerId, time, maxTime) {
    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = createCircularTimer(time, maxTime);
    }
}

// ============================================
// PLAYER REACTIONS
// ============================================

function sendReaction(emoji) {
    // Show local reaction immediately
    showFloatingReaction(emoji);
    
    // Send to other players via WebSocket
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ 
            action: 'reaction', 
            userId, 
            matchToken,
            emoji 
        }));
    }
}

function showFloatingReaction(emoji, fromPlayer = null) {
    const reaction = document.createElement('div');
    reaction.className = 'floating-reaction';
    reaction.textContent = emoji;
    
    // Random horizontal position
    const randomX = 20 + Math.random() * 60; // 20% to 80% of screen width
    reaction.style.left = randomX + '%';
    reaction.style.bottom = '100px';
    
    document.body.appendChild(reaction);
    setTimeout(() => reaction.remove(), 2000);
}

// Handle incoming reactions from other players
function handleReaction(data) {
    showFloatingReaction(data.emoji, data.player);
}

// ============================================
// VOICE CHAT (AGORA)
// ============================================

const AGORA_APP_ID = 'bfb23a30fb7349438d544b129ce4bd51';
let agoraClient = null;
let localAudioTrack = null;
let isInVoiceChat = false;
let isMuted = false;
let voiceParticipants = new Map(); // odUserId -> {name, odUserId}

async function initAgoraClient() {
    if (!window.AgoraRTC) {
        console.error('Agora SDK not loaded');
        return false;
    }
    
    if (!agoraClient) {
        agoraClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        
        // Handle user published (someone joins voice)
        agoraClient.on('user-published', async (user, mediaType) => {
            await agoraClient.subscribe(user, mediaType);
            if (mediaType === 'audio') {
                user.audioTrack.play();
                addVoiceParticipant(user.uid, 'Player');
            }
        });
        
        // Handle user unpublished (someone leaves voice)
        agoraClient.on('user-unpublished', (user) => {
            removeVoiceParticipant(user.uid);
        });
        
        // Handle user left
        agoraClient.on('user-left', (user) => {
            removeVoiceParticipant(user.uid);
        });
        
        // Handle volume indicator for speaking animation
        agoraClient.enableAudioVolumeIndicator();
        agoraClient.on('volume-indicator', (volumes) => {
            volumes.forEach(volume => {
                const el = document.querySelector(`[data-odUserId="${volume.uid}"]`);
                if (el) {
                    if (volume.level > 5) {
                        el.classList.remove('not-speaking');
                    } else {
                        el.classList.add('not-speaking');
                    }
                }
            });
        });
    }
    return true;
}

async function toggleVoiceChat() {
    if (isInVoiceChat) {
        await leaveVoiceChat();
    } else {
        await joinVoiceChat();
    }
}

async function joinVoiceChat() {
    try {
        updateVoiceStatus('connecting', t('voiceConnecting'));
        
        const initialized = await initAgoraClient();
        if (!initialized) {
            alert('Voice chat not available');
            updateVoiceStatus('disconnected', t('voiceDisconnected'));
            return;
        }
        
        // Use room code as channel name
        const channelName = currentRoomCode || 'default';
        
        // Join the channel (null token for testing, odUserId is a random number)
        const odUserId = Math.floor(Math.random() * 100000);
        await agoraClient.join(AGORA_APP_ID, channelName, null, odUserId);
        
        // Create and publish local audio track
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        await agoraClient.publish([localAudioTrack]);
        
        isInVoiceChat = true;
        isMuted = false;
        
        // Update UI
        updateVoiceStatus('connected', t('voiceConnected'));
        updateVoiceButtons();
        
        // Add self to participants
        const myName = document.getElementById('createName')?.value || 
                       document.getElementById('joinName')?.value || 'You';
        addVoiceParticipant(odUserId, myName + ' (You)');
        
    } catch (error) {
        console.error('Failed to join voice chat:', error);
        alert('Failed to join voice chat: ' + error.message);
        updateVoiceStatus('disconnected', t('voiceDisconnected'));
    }
}

async function leaveVoiceChat() {
    try {
        if (localAudioTrack) {
            localAudioTrack.close();
            localAudioTrack = null;
        }
        
        if (agoraClient) {
            await agoraClient.leave();
        }
        
        isInVoiceChat = false;
        isMuted = false;
        voiceParticipants.clear();
        
        // Update UI
        updateVoiceStatus('disconnected', t('voiceDisconnected'));
        updateVoiceButtons();
        renderVoiceParticipants();
        
    } catch (error) {
        console.error('Failed to leave voice chat:', error);
    }
}

function toggleMute() {
    if (!localAudioTrack) return;
    
    isMuted = !isMuted;
    localAudioTrack.setEnabled(!isMuted);
    
    const muteIcon = document.getElementById('muteIcon');
    const muteBtn = document.getElementById('muteBtn');
    
    if (muteIcon) {
        muteIcon.textContent = isMuted ? '🔇' : '🔊';
    }
    if (muteBtn) {
        muteBtn.classList.toggle('muted', isMuted);
    }
}

function updateVoiceStatus(status, text) {
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.voice-status span:last-child');
    
    if (statusDot) {
        statusDot.className = 'status-dot ' + status;
    }
    if (statusText) {
        statusText.textContent = text;
    }
}

function updateVoiceButtons() {
    const joinBtn = document.getElementById('joinVoiceBtn');
    const voiceIcon = document.getElementById('voiceIcon');
    const voiceBtnText = document.getElementById('voiceBtnText');
    const muteBtn = document.getElementById('muteBtn');
    
    if (isInVoiceChat) {
        if (joinBtn) joinBtn.classList.add('active');
        if (voiceIcon) voiceIcon.textContent = '📞';
        if (voiceBtnText) voiceBtnText.textContent = t('leaveVoice');
        if (muteBtn) muteBtn.style.display = 'flex';
    } else {
        if (joinBtn) joinBtn.classList.remove('active');
        if (voiceIcon) voiceIcon.textContent = '🎤';
        if (voiceBtnText) voiceBtnText.textContent = t('joinVoice');
        if (muteBtn) muteBtn.style.display = 'none';
    }
}

function addVoiceParticipant(odUserId, name) {
    voiceParticipants.set(odUserId, { name, odUserId });
    renderVoiceParticipants();
}

function removeVoiceParticipant(odUserId) {
    voiceParticipants.delete(odUserId);
    renderVoiceParticipants();
}

function renderVoiceParticipants() {
    const container = document.getElementById('voiceParticipants');
    if (!container) return;
    
    if (voiceParticipants.size === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = Array.from(voiceParticipants.values()).map(p => `
        <div class="voice-participant not-speaking" data-odUserId="${p.odUserId}">
            <span class="speaking-indicator"></span>
            <span>${p.name}</span>
        </div>
    `).join('');
}

// Clean up voice chat when leaving game
function cleanupVoiceChat() {
    if (isInVoiceChat) {
        leaveVoiceChat();
    }
}

// Add cleanup when showing home screen
const originalShowHome = showHome;
showHome = function() {
    cleanupVoiceChat();
    originalShowHome();
};
