/* ============================================================
   QPUC — game-patches.js
   Toybox-era overrides for game.js render functions.
   Loaded AFTER game.js so these definitions win.

   Each override replaces ONE function. Original logic preserved
   where possible; only markup output is changed to match new
   Toybox DOM (base.css + app.css primitives).

   Touchpoints:
     - renderPublicRooms          → .pr-room cards (used in Join screen list)
     - selectVisibility           → .seg__btn.is-on toggle
     - selectGameMode             → .mode-card.is-on highlight
     - renderSubjectsToContainer  → .subject-pill toggles (keeps hidden checkboxes)
     - selectJoinTeam             → team button highlight
     - renderPlayerCards          → flanking .player-tile seats (game screen)
     - updatePlayerCardsScores    → score pill updates
     - highlightBuzzedPlayer      → .is-buzzing on flanking seats
     - showQuestion (options part) → colored .option--a/b/c/d
     - closePodiumAndShowMultiGameOver → new podium + scoreboard
     - renderLobbyPlayers (NEW)   → seat tiles in lobby
   ============================================================ */

(function() {
    'use strict';

    // ── Helpers ───────────────────────────────────────────────

    const TEAM_TINTS = ['coral', 'sky', 'mint', 'amber'];
    function tintForIndex(i) { return TEAM_TINTS[i % TEAM_TINTS.length]; }

    function avatarHtml(url, name) {
        if (url) {
            return `<img src="${url}" alt="${escapeHtml(name || '')}" onerror="this.style.display='none'">`;
        }
        const initial = (name || '?').charAt(0).toUpperCase();
        return `<span style="font-size:24px;font-weight:800;">${initial}</span>`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function safeAvatarUrl(name) {
        if (typeof generateAvatarUrlFromName === 'function') {
            try { return generateAvatarUrlFromName(name); } catch(e) {}
        }
        return null;
    }

    function getPlayerAvatarFor(name) {
        const gamePlayers = window.currentGamePlayers || [];
        const myName = document.getElementById('createName')?.value ||
                       document.getElementById('joinName')?.value || '';
        const server = gamePlayers.find(p => p.name === name);
        if (server && server.avatar && typeof generateAvatarUrl === 'function') {
            return generateAvatarUrl(server.avatar);
        }
        if (name === myName && window.currentAvatar && typeof generateAvatarUrl === 'function') {
            return generateAvatarUrl(window.currentAvatar);
        }
        return safeAvatarUrl(name);
    }


    // ── Public rooms list (Join screen) ───────────────────────

    window.renderPublicRooms = function(rooms) {
        const container = document.getElementById('publicRoomsList');
        if (!container) return;

        if (!rooms || rooms.length === 0) {
            container.innerHTML = `
                <div style="text-align:center;padding:32px 16px;color:var(--ink-faint);font-weight:500;font-size:14px;">
                    Aucune partie publique en ce moment.
                </div>`;
            return;
        }

        container.innerHTML = rooms.map(room => {
            const isFull = room.playerCount >= room.maxPlayers;
            const isPlaying = room.state === 'playing' || room.inProgress;
            const disabled = isFull || isPlaying;
            const stateLabel = isPlaying ? 'En cours' : (isFull ? 'Pleine' : 'En attente');
            const stateClass = isPlaying ? 'pr-state--playing' : (isFull ? 'pr-state--full' : 'pr-state--waiting');
            const modeLabel = room.gameMode === 'team' ? 'En équipe' : 'Chacun pour soi';
            const onclick = disabled ? '' : `onclick="joinPublicRoom('${escapeHtml(room.code)}')"`;
            return `
                <button class="pr-room ${disabled ? 'is-disabled' : ''}" ${onclick} ${disabled ? 'disabled' : ''}>
                    <div class="pr-room__head">
                        <span class="pr-room__code">${escapeHtml(room.code)}</span>
                        <span class="pr-room__state ${stateClass}">${stateLabel}</span>
                    </div>
                    <div class="pr-room__meta">
                        <span class="pr-room__tag">${modeLabel}</span>
                        <span class="pr-room__tag">${room.playerCount}/${room.maxPlayers} joueurs</span>
                    </div>
                </button>`;
        }).join('');
    };


    // ── Visibility segmented toggle ───────────────────────────

    window.selectVisibility = function(visibility) {
        window.selectedRoomVisibility = visibility;
        try { selectedRoomVisibility = visibility; } catch (e) {}
        const pub = document.getElementById('visibilityPublic');
        const priv = document.getElementById('visibilityPrivate');
        [pub, priv].forEach(el => el && el.classList.remove('is-on', 'selected'));
        const target = visibility === 'public' ? pub : priv;
        if (target) target.classList.add('is-on');
    };


    // ── Game mode card selection ──────────────────────────────

    window.selectGameMode = function(mode) {
        window.selectedGameMode = mode;
        // Mirror to game.js's global if it exists (cross-script lexical share)
        try { selectedGameMode = mode; } catch (e) {}
        const ffa = document.getElementById('gameModeFF');
        const team = document.getElementById('gameModeTeam');
        [ffa, team].forEach(el => el && el.classList.remove('is-on', 'selected'));
        const target = mode === 'ffa' ? ffa : team;
        if (target) target.classList.add('is-on');

        // Update the one-line description so the consequence of the choice is clear.
        const hint = document.getElementById('gameModeHint');
        if (hint) {
            hint.textContent = (mode === 'team')
                ? 'Exactement 4 joueurs, en 2 équipes de 2. Les points sont communs ; la partie démarre une fois les équipes complètes.'
                : '2 à 4 joueurs. Chacun joue pour soi — le meilleur score gagne. La partie démarre dès 2 joueurs.';
        }
    };


    // ── Subjects picker (used by both Solo and Create screens) ─

    // The original JS reads selections via input[type=checkbox]:checked,
    // so we render visible pill UI with hidden checkboxes underneath.
    window.renderSubjectsToContainer = function(containerId) {
        const container = document.getElementById(containerId);
        if (!container || typeof SUBJECTS === 'undefined') return;
        container.innerHTML = '';
        // Only the solo container is visible; createSubjects stays hidden
        // (the Create screen shows a summary + "Modifier", not the raw pills).
        if (containerId === 'soloSubjects') {
            container.classList.remove('hidden');
        }

        SUBJECTS.forEach(subject => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'subject-pill is-on';
            pill.dataset.subject = subject;

            const hiddenCb = document.createElement('input');
            hiddenCb.type = 'checkbox';
            hiddenCb.id = `${containerId}-${subject}`;
            hiddenCb.value = subject;
            hiddenCb.checked = true;
            hiddenCb.style.display = 'none';

            const label = t('subjects.' + subject) || subject;
            pill.innerHTML = `
                <span class="subject-pill__icon">
                    <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>
                </span>
                <span>${escapeHtml(label)}</span>`;
            pill.appendChild(hiddenCb);

            pill.addEventListener('click', (e) => {
                if (e.target === hiddenCb) return;
                e.preventDefault();
                hiddenCb.checked = !hiddenCb.checked;
                pill.classList.toggle('is-on', hiddenCb.checked);
                // Swap icon for the unchecked state
                const iconSpan = pill.querySelector('.subject-pill__icon');
                if (iconSpan) {
                    if (hiddenCb.checked) {
                        iconSpan.innerHTML = `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>`;
                    } else {
                        iconSpan.innerHTML = `<svg width="13" height="13" viewBox="0 0 256 256" fill="var(--primary)"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>`;
                    }
                }
            });

            container.appendChild(pill);
        });
    };

    // Toggle-all for solo: pulls all pills in #soloSubjects and flips checkboxes.
    window.toggleAllSubjects = function(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const checkboxes = container.querySelectorAll('input[type="checkbox"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => {
            cb.checked = !allChecked;
            const pill = cb.closest('.subject-pill');
            if (pill) {
                pill.classList.toggle('is-on', cb.checked);
                const iconSpan = pill.querySelector('.subject-pill__icon');
                if (iconSpan) {
                    if (cb.checked) {
                        iconSpan.innerHTML = `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>`;
                    } else {
                        iconSpan.innerHTML = `<svg width="13" height="13" viewBox="0 0 256 256" fill="var(--primary)"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>`;
                    }
                }
            }
        });
    };

    // Convenience alias used by the new HTML
    window.toggleAllSoloSubjects = () => window.toggleAllSubjects('soloSubjects');


    // ── Join team selector ───────────────────────────────────

    window.selectJoinTeam = function(team) {
        window.selectedJoinTeam = team;
        const red = document.getElementById('joinTeamRed');
        const blue = document.getElementById('joinTeamBlue');
        [red, blue].forEach(el => {
            if (!el) return;
            el.classList.remove('selected', 'is-on');
            el.style.outline = '';
        });
        const target = team === 'red' ? red : blue;
        if (target) {
            target.classList.add('is-on');
            target.style.outline = `3px solid ${team === 'red' ? 'var(--primary)' : 'var(--tertiary)'}`;
            target.style.outlineOffset = '-3px';
        }
    };


    // ── Player cards (flanking game-screen rails) ────────────

    // The original renderPlayerCards wrote to #playersListHorizontal.
    // We split players into left and right rails (2 each, max 4).
    window.renderPlayerCards = function(players, scores = {}) {
        const left = document.getElementById('playersListLeft');
        const right = document.getElementById('playersListRight');
        if (!left || !right) return;
        left.innerHTML = '';
        right.innerHTML = '';

        const list = players.map((player, idx) => {
            const name = typeof player === 'string' ? player : player.name;
            return {
                name,
                score: scores[name] || 0,
                idx,
                eliminated: typeof player === 'object' && player.eliminated,
                tint: tintForIndex(idx)
            };
        });

        list.forEach((p, i) => {
            const target = (i % 2 === 0) ? left : right;
            const avatarUrl = getPlayerAvatarFor(p.name);
            const tile = document.createElement('div');
            tile.className = 'player-tile player-card' + (p.eliminated ? ' is-out' : '');
            tile.dataset.playerName = p.name;
            tile.innerHTML = `
                <div class="player-avatar-wrap team-${p.tint}">
                    <div class="player-avatar">
                        ${avatarHtml(avatarUrl, p.name)}
                    </div>
                    <span class="player-status-dot ${p.eliminated ? 'is-eliminated' : ''}"></span>
                </div>
                <div class="player-name">${escapeHtml(p.name)}</div>
                <span class="score-pill score-pill--${p.tint} player-score" data-name="${escapeHtml(p.name)}">${p.score} pts</span>
            `;
            target.appendChild(tile);
        });
    };

    // Score updates without re-rendering tiles
    window.updatePlayerCardsScores = function(scores) {
        Object.entries(scores || {}).forEach(([name, score]) => {
            const tiles = document.querySelectorAll(`[data-player-name="${CSS.escape(name)}"]`);
            tiles.forEach(t => {
                const scoreEl = t.querySelector('.score-pill, .player-score');
                if (scoreEl) {
                    scoreEl.textContent = `${score} pts`;
                    scoreEl.classList.add('score-animate');
                    setTimeout(() => scoreEl.classList.remove('score-animate'), 600);
                }
            });
        });
    };

    // Highlight the player who buzzed
    window.highlightBuzzedPlayer = function(playerName) {
        document.querySelectorAll('.player-tile').forEach(t => {
            t.classList.remove('is-buzzing', 'active-buzzer');
            const wrap = t.querySelector('.player-avatar-wrap');
            if (wrap) wrap.classList.remove('is-buzzing');
        });
        const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(playerName) : playerName;
        const tile = document.querySelector(`[data-player-name="${escaped}"]`);
        if (tile) {
            tile.classList.add('is-buzzing');
            const wrap = tile.querySelector('.player-avatar-wrap');
            if (wrap) wrap.classList.add('is-buzzing');
        }
    };


    // ── Options box (in-game answer choices) ─────────────────

    // The new options grid uses 4 colored variants. We intercept
    // by wrapping the original showQuestion to re-render options
    // after it runs.
    const _origShowQuestion = window.showQuestion;
    window.showQuestion = function(data) {
        if (typeof _origShowQuestion === 'function') {
            _origShowQuestion(data);
        }

        // Rewrite options to Toybox colored variants
        const optionsBox = document.getElementById('optionsBox');
        if (optionsBox && data && data.options) {
            optionsBox.innerHTML = '';
            optionsBox.style.display = 'grid';
            const letters = ['A', 'B', 'C', 'D'];
            const variants = ['option--a', 'option--b', 'option--c', 'option--d'];
            data.options.forEach((opt, idx) => {
                const btn = document.createElement('button');
                btn.className = `option ${variants[idx % 4]}`;
                btn.style.animationDelay = (idx * 0.06) + 's';
                btn.innerHTML = `
                    <span class="option__letter">${letters[idx % 4]}</span>
                    <span class="option__text">${escapeHtml(opt)}</span>
                `;
                btn.onclick = () => answerQuestion(idx);
                optionsBox.appendChild(btn);
            });
        }

        // Update the question pill (top-of-card pill, not the badge nested inside)
        const badge = document.getElementById('questionBadge');
        if (badge && data && data.questionInRound) {
            badge.textContent = `Question ${data.questionInRound} / ${data.questionsPerRound || 5}`;
        }

        // Update countdown ring fill (animate stroke-dashoffset over duration)
        const fill = document.getElementById('countdownFill');
        if (fill && data && data.time) {
            const total = 314.16; // 2π * 50
            fill.style.transition = `stroke-dashoffset ${data.time}s linear`;
            fill.style.strokeDashoffset = '0';
            // force reflow then start
            void fill.getBoundingClientRect();
            fill.style.strokeDashoffset = total;
        }
        // (Top progress bar is set in the bugfix block's showQuestion wrapper.)
    };


    // ── Game Over + Lobby seats ──────────────────────────────
    // NOTE: the canonical implementations live in the BUGFIX BLOCK at the
    // bottom of this file (renderMultiGameOver / renderSoloGameOver via
    // closePodium, and the corrected updatePlayers). They are defined later
    // and therefore win. The earlier drafts were removed to avoid confusion.
    // This stub remains only so the historical reference name resolves.
    const __unusedUpdatePlayers = function(data) {
        const container = document.getElementById('playersList');
        if (!container) return;

        const players = data.players || [];
        const maxPlayers = data.maxPlayers || 4;
        const hostName = data.host || (players[0] && (players[0].name || players[0]));
        const readyPlayers = new Set(data.readyPlayers || []);
        const micStates = data.micStates || {}; // { name: 'on'|'off'|'speaking' }
        const myName = document.getElementById('createName')?.value ||
                       document.getElementById('joinName')?.value || '';

        container.innerHTML = '';

        // Render filled seats
        players.forEach((player, idx) => {
            const name = typeof player === 'string' ? player : player.name;
            const isHost = name === hostName;
            const isReady = readyPlayers.has(name);
            const isMe = name === myName;
            const micState = micStates[name] || 'off';
            const tint = tintForIndex(idx);
            const avatarUrl = getPlayerAvatarFor(name);

            let seatClass = 'seat';
            if (isHost) seatClass += ' is-host';
            else if (isReady) seatClass += ' is-ready';

            let micChipClass = 'seat__mic-chip';
            if (micState === 'speaking') micChipClass += ' is-speaking';
            else if (micState === 'on') micChipClass += ' is-on';

            let statusDotIcon = '';
            if (isHost) {
                statusDotIcon = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M243.81,90.36a16,16,0,0,0-14.79-9.85H184.69L154.13,21.46a16,16,0,0,0-28.26,0L95.31,80.51H50.94A16,16,0,0,0,36.16,90.36a16.16,16.16,0,0,0,3.06,17.46l31.17,32.61L57.13,191.27a16.16,16.16,0,0,0,21,18.65L128,189.62l49.9,20.3a16,16,0,0,0,21.05-18.65L185.61,140.43l31.17-32.61A16.16,16.16,0,0,0,243.81,90.36Z"/></svg>`;
            } else if (isReady) {
                statusDotIcon = `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>`;
            }

            const meta = isHost ? (isMe ? 'Vous · Hôte' : 'Hôte')
                       : isReady ? 'Prêt(e)'
                       : (isMe ? 'Vous' : 'Connecté');

            const seat = document.createElement('div');
            seat.className = seatClass;
            seat.dataset.playerName = name;
            seat.innerHTML = `
                <div class="seat__avatar-wrap">
                    <span class="${micChipClass}" title="Micro ${micState}">
                        <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176Z"/>${micState === 'off' ? '<line x1="40" y1="216" x2="216" y2="40" stroke="currentColor" stroke-width="22" stroke-linecap="round"/>' : ''}</svg>
                    </span>
                    <div class="seat__avatar">${avatarHtml(avatarUrl, name)}</div>
                    <span class="seat__status-dot">${statusDotIcon}</span>
                </div>
                <div>
                    <div class="seat__name">${escapeHtml(name)}</div>
                    <div class="seat__meta">${meta}</div>
                </div>
                ${isMe ? `
                    <button class="seat__mic-btn ${micState === 'off' ? 'is-off' : 'is-on'}" onclick="toggleVoiceChat()">
                        <svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176Z"/></svg>
                        ${micState === 'off' ? 'Activer micro' : 'Micro actif'}
                    </button>
                ` : ''}
            `;
            container.appendChild(seat);
        });

        // Render empty seats
        const empty = Math.max(0, maxPlayers - players.length);
        for (let i = 0; i < empty; i++) {
            const seat = document.createElement('div');
            seat.className = 'seat is-empty';
            seat.innerHTML = `
                <div class="seat__empty-icon">
                    <svg width="36" height="36" viewBox="0 0 256 256" fill="currentColor"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>
                </div>
                <div class="seat__empty-label">En attente…</div>
            `;
            container.appendChild(seat);
        }

        // Update lobby count
        const countEl = document.getElementById('lobbyPlayerCount');
        const maxEl = document.getElementById('lobbyPlayerMax');
        if (countEl) countEl.textContent = players.length;
        if (maxEl) maxEl.textContent = maxPlayers;

        // Lobby format info
        if (data.gameMode) {
            const modeEl = document.getElementById('lobbyMode');
            if (modeEl) modeEl.textContent = data.gameMode === 'team' ? 'En équipe' : 'Chacun pour soi';
        }
        if (data.visibility) {
            const visEl = document.getElementById('lobbyVisibility');
            if (visEl) visEl.textContent = data.visibility === 'public' ? 'Publique' : 'Privée';
        }
        if (typeof data.subjectCount === 'number') {
            const subEl = document.getElementById('lobbySubjectCount');
            if (subEl) subEl.textContent = `${data.subjectCount} sujets`;
        }

        // Voice participants count
        const voiceCount = Object.values(micStates).filter(s => s !== 'off').length;
        const vEl = document.getElementById('voiceParticipants');
        if (vEl) vEl.textContent = `${voiceCount} actif${voiceCount !== 1 ? 's' : ''}`;

        // Waiting message
        const waitEl = document.getElementById('lobbyWaitingMsg');
        if (waitEl) {
            if (players.length < 2) {
                waitEl.textContent = 'En attente d\'au moins 2 joueurs…';
            } else if (players.length < maxPlayers) {
                waitEl.textContent = `${players.length} joueur${players.length > 1 ? 's' : ''} · prêt à lancer`;
            } else {
                waitEl.textContent = 'Salon plein';
            }
        }
    };


    // ── AI category toggle (Create screen) ──────────────────

    window.toggleAICategory = function() {
        const btn = document.getElementById('aiToggleMulti');
        const input = document.getElementById('customCategoryInputMulti');
        if (!btn) return;
        btn.classList.toggle('is-off');
        const enabled = !btn.classList.contains('is-off');
        if (input) {
            input.disabled = !enabled;
            input.style.opacity = enabled ? '1' : '0.5';
        }
    };


    // ── Helpers exposed to templates ────────────────────────

    window.openSubjectsPicker = window.openSubjectsPicker || function() {
        // Placeholder: in original flow, subjects were chosen elsewhere.
        // For now, scroll to the (hidden) createSubjects container if present,
        // or open a future picker modal.
        alert('La sélection des sujets sera bientôt disponible. Tous les sujets sont activés par défaut.');
    };

    window.shareRoomLink = window.shareRoomLink || function() {
        const code = document.getElementById('createCode')?.textContent || '';
        if (navigator.share) {
            navigator.share({
                title: 'Questions pour un Champion',
                text: `Rejoignez ma partie avec le code ${code}`,
                url: `${window.location.origin}/play?code=${encodeURIComponent(code)}`
            }).catch(() => {});
        } else if (typeof copyRoomCode === 'function') {
            copyRoomCode();
        }
    };

    window.showHistory = function() {
        // The data model only stores aggregate stats per player (no per-match
        // table exists yet), so we surface those honestly rather than faking
        // a match list.
        const p = window.currentPlayer;
        const existing = document.querySelector('.history-overlay');
        if (existing) existing.remove();

        let inner;
        if (!p) {
            inner = `<p class="no-data">Connectez-vous pour suivre vos statistiques de jeu.</p>`;
        } else {
            const played = p.games_played || 0;
            const won = p.games_won || 0;
            const score = p.total_score || 0;
            const winRate = played > 0 ? Math.round((won / played) * 100) : 0;
            inner = `
                <div class="history-list">
                    <div class="history-row">
                        <span class="history-row__result win">★</span>
                        <div class="history-row__meta">
                            <div class="history-row__title">Parties gagnées</div>
                            <div class="history-row__date">${winRate}% de victoires</div>
                        </div>
                        <span class="history-row__score">${won}</span>
                    </div>
                    <div class="history-row">
                        <span class="history-row__result loss">#</span>
                        <div class="history-row__meta">
                            <div class="history-row__title">Parties jouées</div>
                            <div class="history-row__date">Au total</div>
                        </div>
                        <span class="history-row__score">${played}</span>
                    </div>
                    <div class="history-row">
                        <span class="history-row__result win">Σ</span>
                        <div class="history-row__meta">
                            <div class="history-row__title">Score cumulé</div>
                            <div class="history-row__date">Toutes parties confondues</div>
                        </div>
                        <span class="history-row__score">${score}</span>
                    </div>
                </div>
                <p class="no-data" style="padding:12px 16px;">L'historique partie par partie arrive bientôt.</p>`;
        }

        const html = `
            <div class="history-overlay" onclick="if(event.target===this)this.remove()">
                <div class="history-modal">
                    <h2>Votre <em>historique</em></h2>
                    ${inner}
                    <button class="btn btn--ghost btn--md" style="width:100%;" onclick="this.closest('.history-overlay').remove()">Fermer</button>
                </div>
            </div>`;
        document.body.insertAdjacentHTML('beforeend', html);
    };

    window.showHelp = window.showHelp || function() {
        alert('Aide — bientôt disponible.');
    };

    // NOTE: this game has no "ready" system server-side — start is gated on
    // player count / team balance (server sends data.canStart). The ready
    // button was removed from the lobby; this stub stays only so any stale
    // reference resolves to a harmless no-op.
    window.toggleReady = function() {};

    window.leaveLobby = function() {
        // ws / userId are module-scoped lets in game.js; in classic scripts
        // they're reachable as bare globals here. window.ws was always undefined.
        try {
            if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: 'leaveLobby', userId: (typeof userId !== 'undefined' ? userId : undefined) }));
                ws.close();
            }
        } catch (e) {}
        if (typeof showHome === 'function') showHome();
    };

    window.cancelAILoading = window.cancelAILoading || function() {
        const modal = document.getElementById('aiLoadingModal');
        if (modal) modal.classList.remove('active');
    };


    // ── On-load wiring ───────────────────────────────────────

    document.addEventListener('DOMContentLoaded', () => {
        // Render solo subjects in the new container
        setTimeout(() => {
            if (typeof SUBJECTS !== 'undefined') {
                window.renderSubjectsToContainer('soloSubjects');
            }
        }, 100);
    });

})();


/* ============================================================
   BUGFIX BLOCK — appended after initial review
   Fixes integration bugs between game.js data shapes and the
   new Toybox markup. Each fix notes the bug it addresses.
   ============================================================ */

(function() {
    'use strict';

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }
    function avatarFor(name) {
        const gp = window.currentGamePlayers || [];
        const sv = gp.find(p => p.name === name);
        if (sv && sv.avatar && typeof generateAvatarUrl === 'function') return generateAvatarUrl(sv.avatar);
        if (typeof generateAvatarUrlFromName === 'function') {
            try { return generateAvatarUrlFromName(name); } catch (e) {}
        }
        return null;
    }
    function avatarImg(url, name) {
        return url
            ? `<img src="${url}" alt="${esc(name||'')}" onerror="this.style.display='none'">`
            : `<span style="font-size:24px;font-weight:800;">${esc((name||'?').charAt(0).toUpperCase())}</span>`;
    }
    const TINTS = ['coral','sky','mint','amber'];

    /* ── BUG 5 fix: createCircularTimer injected a full SVG widget into
       #timer (our .countdown__num span), producing a double timer.
       In the browser, game.js's top-level `function createCircularTimer`
       is a property of window and shares its binding with the bare calls
       game.js makes, so reassigning it here changes what those calls emit.
       We make it return just the number; the ring is animated separately
       via #countdownFill. Assigned unconditionally — by the time this file
       runs, game.js has defined the original. ── */
    try {
        window.createCircularTimer = function(time) { return String(time); };
    } catch (e) { /* non-browser: ignore */ }

    /* ── BUG 4 fix: updatePlayers used invented data.host/readyPlayers/
       micStates. The server actually sends per-player isHost + team, plus
       data.canStart and data.teamCounts, and uses the global `isHost`.
       Re-implement against the real shape. ── */
    window.updatePlayers = function(data) {
        const container = document.getElementById('playersList');
        if (!container) return;

        const players = data.players || [];
        const maxPlayers = data.maxPlayers || (data.gameMode === 'team' ? 4 : 4);
        const myName = document.getElementById('createName')?.value ||
                       document.getElementById('joinName')?.value || '';

        container.innerHTML = '';

        players.forEach((player, idx) => {
            const name = typeof player === 'string' ? player : player.name;
            const pIsHost = (typeof player === 'object') && player.isHost;
            const isMe = name === myName;
            const team = (typeof player === 'object') ? player.team : null;
            // Tint: team mode uses team colour, else rotating tint
            const tint = team === 'red' ? 'coral' : team === 'blue' ? 'sky' : TINTS[idx % 4];
            const url = avatarFor(name);

            let seatClass = 'seat';
            if (pIsHost) seatClass += ' is-host';

            const statusIcon = pIsHost
                ? `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M243.81,90.36a16,16,0,0,0-14.79-9.85H184.69L154.13,21.46a16,16,0,0,0-28.26,0L95.31,80.51H50.94A16,16,0,0,0,36.16,90.36a16.16,16.16,0,0,0,3.06,17.46l31.17,32.61L57.13,191.27a16.16,16.16,0,0,0,21,18.65L128,189.62l49.9,20.3a16,16,0,0,0,21.05-18.65L185.61,140.43l31.17-32.61A16.16,16.16,0,0,0,243.81,90.36Z"/></svg>`
                : '';

            const teamLabel = team ? (team === 'red' ? ' · Rouge' : ' · Bleu') : '';
            const meta = pIsHost ? (isMe ? 'Vous · Hôte' : 'Hôte') : (isMe ? 'Vous' + teamLabel : 'Connecté' + teamLabel);

            const seat = document.createElement('div');
            seat.className = seatClass;
            seat.dataset.playerName = name;
            seat.innerHTML = `
                <div class="seat__avatar-wrap">
                    <div class="seat__avatar">${avatarImg(url, name)}</div>
                    <span class="seat__status-dot">${statusIcon}</span>
                </div>
                <div>
                    <div class="seat__name">${esc(name)}</div>
                    <div class="seat__meta">${meta}</div>
                </div>
                ${isMe ? `
                    <button class="seat__mic-btn is-off" id="lobbyMicBtn" onclick="toggleVoiceChat()">
                        <svg width="11" height="11" viewBox="0 0 256 256" fill="currentColor"><path d="M128,176a48.05,48.05,0,0,0,48-48V64a48,48,0,0,0-96,0v64A48.05,48.05,0,0,0,128,176Z"/></svg>
                        Activer micro
                    </button>` : ''}
            `;
            container.appendChild(seat);
        });

        // Empty seats
        for (let i = players.length; i < maxPlayers; i++) {
            const seat = document.createElement('div');
            seat.className = 'seat is-empty';
            seat.innerHTML = `
                <div class="seat__empty-icon">
                    <svg width="36" height="36" viewBox="0 0 256 256" fill="currentColor"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>
                </div>
                <div class="seat__empty-label">En attente…</div>`;
            container.appendChild(seat);
        }

        // Format info (mode / visibility / subjects) when present
        const modeEl = document.getElementById('lobbyMode');
        if (modeEl && data.gameMode) modeEl.textContent = data.gameMode === 'team' ? 'En équipe' : 'Chacun pour soi';

        // Player count
        const countEl = document.getElementById('lobbyPlayerCount');
        const maxEl = document.getElementById('lobbyPlayerMax');
        if (countEl) countEl.textContent = players.length;
        if (maxEl) maxEl.textContent = maxPlayers;

        // Preserve original side-effects: global count + language re-render
        if (typeof currentLobbyPlayerCount !== 'undefined') {
            window.currentLobbyPlayerCount = players.length;
        }
        if (typeof updateLobbyPlayerCount === 'function') updateLobbyPlayerCount();

        // BUG: start button must follow the real (isHost && canStart) gate.
        // canStart may be absent in some payloads; fall back to "host + 2+ players".
        const startBtn = document.getElementById('startBtn');
        if (startBtn) {
            let amHost = false;
            try { amHost = (typeof isHost !== 'undefined') ? isHost : false; } catch (e) { amHost = false; }
            // Also trust per-player isHost for the local user
            if (!amHost) {
                const me = players.find(p => (typeof p === 'object') && p.name === myName);
                if (me && me.isHost) amHost = true;
            }
            const enoughPlayers = players.length >= 2;
            const canStart = ('canStart' in data) ? !!data.canStart : enoughPlayers;
            startBtn.style.display = (amHost && canStart) ? 'inline-flex' : 'none';
        }

        // Waiting message — explains the start requirement per mode so the
        // hidden start button isn't mysterious.
        const waitEl = document.getElementById('lobbyWaitingMsg');
        if (waitEl) {
            const isTeam = data.gameMode === 'team';
            if (isTeam) {
                const tc = data.teamCounts || { red: 0, blue: 0 };
                if (players.length < 4) {
                    waitEl.textContent = `Équipes : ${tc.red || 0}/2 rouge · ${tc.blue || 0}/2 bleu — il faut 4 joueurs (2 v 2)`;
                } else {
                    waitEl.textContent = 'Équipes complètes · prêt à lancer';
                }
            } else {
                if (players.length < 2) waitEl.textContent = "En attente d'au moins 2 joueurs…";
                else if (players.length < maxPlayers) waitEl.textContent = `${players.length} joueurs · l'hôte peut lancer`;
                else waitEl.textContent = 'Salon plein · prêt à lancer';
            }
        }
    };

    /* ── BUG 1 fix: for multiplayer, closePodium() routed straight to
       homeScreen, so our game-over screen never showed. Re-route it to
       a proper multiplayer game-over renderer. ── */
    window.closePodium = function() {
        const overlay = document.querySelector('.podium-overlay');
        if (overlay) overlay.remove();

        if (window.podiumIsSolo) {
            renderSoloGameOver();
        } else {
            renderMultiGameOver();
        }
    };

    /* ── BUG 2 fix (multiplayer game-over): emit Toybox podium + scoreboard. ── */
    function renderMultiGameOver() {
        const data = window.multiGameOverData;
        if (typeof showScreen === 'function') showScreen('gameOverScreen');
        if (!data) return;

        const sorted = Object.entries(data.finalScores || {})
            .map(([name, score]) => ({ name, score }))
            .sort((a, b) => b.score - a.score);

        const codeEl = document.getElementById('gameOverRoomCode');
        if (codeEl) codeEl.textContent = data.roomCode || window.currentRoomCode || '——';

        const winnerBox = document.getElementById('winnerBox');
        if (winnerBox) {
            winnerBox.innerHTML = data.winner
                ? `<em>${esc(data.winner)}</em> remporte la partie`
                : esc(data.reason || 'Partie terminée');
        }

        // Stats (preserved)
        const myName = document.getElementById('createName')?.value ||
                       document.getElementById('joinName')?.value || '';
        if (window.currentPlayer && myName && typeof updatePlayerStats === 'function') {
            const i = sorted.findIndex(p => p.name === myName);
            if (i !== -1) updatePlayerStats(sorted[i].score, i === 0, sorted.length, i + 1);
        }

        renderPodium(sorted);
        renderScoreboard(sorted, data.winner);
        if (typeof createConfetti === 'function') createConfetti(80);
    }

    /* ── BUG 2 fix (solo game-over): the called function is
       closePodiumAndShowGameOver. Override it to emit Toybox markup,
       reading score from #soloScore (we can't see the soloScore var
       from this scope). ── */
    function renderSoloGameOver() {
        if (typeof showScreen === 'function') showScreen('gameOverScreen');

        const name = document.getElementById('soloName')?.value || 'Joueur';
        const scoreText = document.getElementById('soloScore')?.textContent || '0';
        const score = parseInt(scoreText, 10) || 0;

        const codeEl = document.getElementById('gameOverRoomCode');
        if (codeEl) codeEl.textContent = 'SOLO';

        const winnerBox = document.getElementById('winnerBox');
        if (winnerBox) winnerBox.innerHTML = `<em>${esc(name)}</em> · ${score} points`;

        renderPodium([{ name, score }]);
        renderScoreboard([{ name, score }], name);
    }
    window.closePodiumAndShowGameOver = renderSoloGameOver;
    window.closePodiumAndShowMultiGameOver = renderMultiGameOver;

    function renderPodium(sorted) {
        const c = document.getElementById('podiumClubhouse');
        if (!c || !sorted.length) return;
        const order = [sorted[1] || null, sorted[0] || null, sorted[2] || null];
        const spot = ['podium-spot--2','podium-spot--1','podium-spot--3'];
        const rank = ['podium-rank--2','podium-rank--1','podium-rank--3'];
        const num = [2,1,3];
        c.innerHTML = order.map((p,i) => {
            if (!p) return '<div class="podium-spot"></div>';
            const crown = i === 1
                ? `<svg class="podium-crown" width="44" height="44" viewBox="0 0 256 256" fill="currentColor"><path d="M248,80a28,28,0,1,0-51.12,15.77l-26.79,33L146.36,80.27a28,28,0,1,0-36.72,0L86.91,128.74l-26.79-33a28,28,0,1,0-26.15,4.95L48,192H208l13.95-91.31A28,28,0,0,0,248,80Z"/></svg>`
                : '';
            return `
                <div class="podium-spot ${spot[i]}">
                    ${crown}
                    <span class="podium-rank-badge ${rank[i]}">${num[i]}</span>
                    <div class="podium__avatar-wrap"><div class="podium__avatar">${avatarImg(avatarFor(p.name), p.name)}</div></div>
                    <div style="text-align:center;">
                        <div class="podium__name">${esc(p.name)}</div>
                        <div class="podium__score">${p.score}</div>
                    </div>
                    <div class="podium__base"></div>
                </div>`;
        }).join('');
    }

    function renderScoreboard(sorted, winner) {
        const el = document.getElementById('finalScores');
        if (!el) return;
        el.innerHTML = sorted.map((p, idx) => {
            const isWin = idx === 0;
            const tint = TINTS[idx % 4];
            const meta = (isWin && winner === p.name) ? 'CHAMPION(NE)' : `${idx + 1}ᵉ place`;
            return `
                <div class="sb-row ${isWin ? 'is-winner' : ''}">
                    <span class="sb-row__rank">${idx + 1}</span>
                    <div class="sb-row__player">
                        <span class="mini-av mini-av--${tint}">${avatarImg(avatarFor(p.name), p.name)}</span>
                        <div>
                            <div class="sb-row__name">${esc(p.name)}</div>
                            <div class="sb-row__meta">${meta}</div>
                        </div>
                    </div>
                    <span class="sb-row__stat"><b>—</b></span>
                    <span class="sb-row__stat"><b>—</b></span>
                    <span class="sb-row__final">${p.score}</span>
                </div>`;
        }).join('');
    }

    /* ── BUG 3 fix: progress bar used non-existent data.totalQuestions.
       Recompute from questionInRound / questionsPerRound / round. The
       game is 3 rounds; approximate overall progress. ── */
    const _prevShowQuestion = window.showQuestion;
    window.showQuestion = function(data) {
        if (typeof _prevShowQuestion === 'function') _prevShowQuestion(data);
        const progress = document.getElementById('progressFill');
        if (progress && data) {
            const perRound = data.questionsPerRound || 5;
            const round = data.round || 1;
            const inRound = data.questionInRound || 1;
            const totalRounds = 3;
            const done = ((round - 1) * perRound) + inRound;
            const total = totalRounds * perRound;
            progress.style.width = `${Math.min(100, (done / total) * 100)}%`;
        }
    };

    /* ── BUG fix: clicking the login pill opened then instantly closed the
       auth card. The pill has child spans, so the document click-outside
       handler in game.js (which compares e.target to the button element)
       saw the inner span, decided the click was "outside", and closed the
       card in the same event cycle. We wrap toggleAuthCard to stop the
       event from bubbling to that handler. ── */
    const _origToggleAuthCard = window.toggleAuthCard;
    window.toggleAuthCard = function(e) {
        // The inline onclick passes the event in most browsers via arguments
        const ev = e || window.event;
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        if (typeof _origToggleAuthCard === 'function') {
            _origToggleAuthCard();
        } else {
            const card = document.getElementById('authCard');
            if (card) card.classList.toggle('visible');
        }
    };

    /* ── Confetti palette: the original createConfetti pulled colours from a
       dead theme map and fell back to neon, clashing with Toybox. Re-implement
       with brand colours. The .confetti shape/animation lives in app.css. ── */
    window.createConfetti = function(count) {
        const n = count || 50;
        const colors = ['#9C3B3E', '#FD8585', '#2C673C', '#B2F2BB', '#2A6082', '#A5D8FF', '#FED01B'];
        for (let i = 0; i < n; i++) {
            const piece = document.createElement('div');
            piece.className = 'confetti';
            piece.style.left = (Math.random() * 100) + 'vw';
            piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            piece.style.animationDelay = (Math.random() * 0.5) + 's';
            document.body.appendChild(piece);
            setTimeout(() => piece.remove(), 3500);
        }
    };

    /* ── Close the auth card after a successful login/register. The original
       handlers only called updateAuthUI() and left the panel open. ── */
    ['handleLogin', 'handleRegister'].forEach(fnName => {
        const orig = window[fnName];
        if (typeof orig !== 'function') return;
        window[fnName] = async function() {
            const r = await orig.apply(this, arguments);
            // updateAuthUI swaps to profileSection on success; if currentPlayer
            // is now set, the login worked — close the panel.
            try {
                if (typeof currentPlayer !== 'undefined' && currentPlayer) {
                    if (typeof closeAuthCard === 'function') closeAuthCard();
                }
            } catch (e) {}
            return r;
        };
    });


    /* ── Default game mode + visibility so the lobby's canStart logic and the
       server payload are never missing these. ── */
    if (!window.selectedRoomVisibility) window.selectedRoomVisibility = 'public';
    if (!window.selectedGameMode) window.selectedGameMode = 'ffa';


    /* ── CRITICAL fix: room code never appeared & games couldn't launch ──
       The redesign turned #createCode from an <input> into a <p> display
       element. game.js's createRoom() reads #createCode.value — undefined on
       a <p> — so the code came back empty, createRoom bailed with an alert,
       and no room (hence no code, no launch) was ever created. Likewise the
       original auto-fill set codeInput.value, which does nothing on a <p>.

       Fix: generate the code into the element's text when the create screen
       opens, mirror it to a hidden value, and override createRoom to read
       from textContent/value robustly. ── */

    function genRoomCode() {
        if (typeof generateRoomCode === 'function') {
            try { return generateRoomCode(); } catch (e) {}
        }
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let c = '';
        for (let i = 0; i < 4; i++) c += chars.charAt(Math.floor(Math.random() * chars.length));
        return c;
    }

    function readCreateCode() {
        const el = document.getElementById('createCode');
        if (!el) return '';
        // Works whether #createCode is an <input> (.value) or <p> (.textContent)
        const raw = (typeof el.value === 'string' && el.value) ? el.value : (el.textContent || '');
        const cleaned = raw.replace(/[^A-Za-z0-9]/g, '').trim().toUpperCase();
        return cleaned;
    }

    function ensureRoomCode() {
        const el = document.getElementById('createCode');
        if (!el) return '';
        let code = readCreateCode();
        if (!code || code.length < 4) {
            code = genRoomCode();
            // Write to whichever surface the element uses
            if ('value' in el && el.tagName === 'INPUT') el.value = code;
            el.textContent = code;
        }
        window.currentRoomCode = code;
        return code;
    }

    // Generate + show the code whenever the create screen opens.
    const _origShowCreateMulti = window.showCreateMulti;
    window.showCreateMulti = function() {
        if (typeof _origShowCreateMulti === 'function') {
            _origShowCreateMulti();
        } else if (typeof showScreen === 'function') {
            showScreen('createMultiScreen');
        }
        // Default selections so the segmented control + visibility are valid
        if (typeof window.selectGameMode === 'function') {
            window.selectGameMode(window.selectedGameMode || 'ffa');
        }
        if (typeof window.selectVisibility === 'function') {
            window.selectVisibility(window.selectedRoomVisibility || 'public');
        }
        setTimeout(ensureRoomCode, 50);
    };

    // Override createRoom so it reads the code from the display element.
    const _origCreateRoom = window.createRoom;
    window.createRoom = function() {
        const code = ensureRoomCode();
        const nameEl = document.getElementById('createName');
        const name = nameEl ? nameEl.value.trim() : '';

        if (!name) {
            const err = document.getElementById('authError');
            alert(typeof t === 'function' ? t('alertBothFields') : 'Entrez votre nom.');
            if (nameEl) nameEl.focus();
            return;
        }

        // Sync globals game.js relies on
        window.currentRoomCode = code;
        try { currentRoomCode = code; } catch (e) {}
        try { gameMode = 'multiplayer'; } catch (e) {}

        const subjects = (typeof getSelectedSubjects === 'function')
            ? getSelectedSubjects('createSubjects') : [];
        const customCategory = document.getElementById('customCategoryInputMulti')?.value.trim();
        const isPublic = (window.selectedRoomVisibility || 'public') === 'public';
        const mode = window.selectedGameMode || 'ffa';

        if (customCategory && typeof createRoomWithAI === 'function') {
            createRoomWithAI(code, name, customCategory);
        } else if (subjects.length > 0 && typeof connectWebSocket === 'function') {
            connectWebSocket(code, name, true, subjects, mode, isPublic);
        } else {
            // No subjects selected: default to all subjects rather than blocking.
            const all = (typeof SUBJECTS !== 'undefined') ? SUBJECTS.slice() : [];
            if (all.length && typeof connectWebSocket === 'function') {
                connectWebSocket(code, name, true, all, mode, isPublic);
            } else {
                alert(typeof t === 'function' ? t('alertSubjects') : 'Choisissez au moins un sujet.');
            }
        }
    };

})();


/* ============================================================
   BUGFIX BLOCK 2 — solo start + multiplayer in-game UI
   These address mismatches between game.js (old "ch-" DOM) and
   the redesigned Toybox markup that the earlier patches missed.
   Loaded last, so these definitions win.
   ============================================================ */

(function() {
    'use strict';

    /* ── SOLO FIX: solo never started ──────────────────────────
       The patched renderSubjectsToContainer renders .subject-pill
       buttons with hidden <input type=checkbox> underneath, but
       game.js's getSelectedSubjects still read .setup-cat-card.selected
       (which no longer exists). It always returned [], so startSoloGame
       bailed with "choisissez un sujet". Read the real markup. ── */
    window.getSelectedSubjects = function(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return [];
        // New Toybox markup: hidden checkboxes inside .subject-pill
        const checks = container.querySelectorAll('input[type="checkbox"]');
        if (checks.length) {
            return Array.from(checks)
                .filter(cb => cb.checked)
                .map(cb => cb.value)
                .filter(Boolean);
        }
        // Legacy fallback
        return Array.from(container.querySelectorAll('.setup-cat-card.selected'))
            .map(card => card.dataset.subject)
            .filter(Boolean);
    };

    /* ── MP FIX 1: in-game player rails were empty ─────────────
       game.js initializeGameScreen() called renderClubhousePlayers(),
       which writes to #chPlayersLayer — gone in the new layout. Route
       it through the patched renderPlayerCards (#playersListLeft/Right)
       and prime the staged buzz reveal. ── */
    window.initializeGameScreen = function(players, scores = {}) {
        const list = players || window.currentGamePlayers || [];
        if (typeof window.renderPlayerCards === 'function') {
            window.renderPlayerCards(list, scores || {});
        }
        const buzzer = document.getElementById('buzzer');
        if (buzzer) { buzzer.disabled = false; buzzer.classList.remove('buzzed'); }
        const wrap = document.querySelector('.buzzer-wrap');
        if (wrap) wrap.style.display = '';
        const optionsBox = document.getElementById('optionsBox');
        if (optionsBox) optionsBox.style.display = 'none';
    };

    /* ── MP FIX 2: staged reveal + live countdown number ───────
       The earlier showQuestion override forced the options visible
       immediately (defeating the buzzer flow) and game.js's timer
       interval wrote to #timerValue, which doesn't exist (the new
       countdown number is #timer). Hide options until buzz and drive
       #timer ourselves. Wraps the existing chain. ── */
    const _chainShowQuestion = window.showQuestion;
    window.showQuestion = function(data) {
        if (typeof _chainShowQuestion === 'function') _chainShowQuestion(data);

        // Staged reveal: options hidden, buzzer shown until someone buzzes.
        const optionsBox = document.getElementById('optionsBox');
        if (optionsBox) optionsBox.style.display = 'none';
        const wrap = document.querySelector('.buzzer-wrap');
        if (wrap) wrap.style.display = '';
        const buzzer = document.getElementById('buzzer');
        if (buzzer) {
            buzzer.disabled = false;
            buzzer.classList.remove('buzzed');
            const txt = buzzer.querySelector('.buzzer__text');
            if (txt && typeof t === 'function') txt.textContent = t('buzz');
        }

        // Numeric countdown on #timer (ring is animated via #countdownFill).
        const timerEl = document.getElementById('timer');
        let secs = data && data.time ? data.time : 10;
        if (timerEl) timerEl.textContent = secs;
        clearInterval(window._mpTimerInt);
        window._mpTimerInt = setInterval(() => {
            secs--;
            if (timerEl) timerEl.textContent = Math.max(0, secs);
            if (secs <= 0) clearInterval(window._mpTimerInt);
        }, 1000);
    };

    /* Build colored .option buttons into a container from a list of
       answer strings. Reused by the multiplayer buzz reveal and the solo
       restyler so both look identical. */
    const OPT_LETTERS = ['A', 'B', 'C', 'D'];
    const OPT_VARIANTS = ['option--a', 'option--b', 'option--c', 'option--d'];
    function paintColoredOptions(box, items, onClick, letterFor) {
        box.innerHTML = '';
        box.style.display = 'grid';
        items.forEach((label, idx) => {
            const btn = document.createElement('button');
            btn.className = 'option ' + OPT_VARIANTS[idx % 4];
            btn.style.animationDelay = (idx * 0.06) + 's';
            const letter = document.createElement('span');
            letter.className = 'option__letter';
            letter.textContent = letterFor ? letterFor(idx, label) : OPT_LETTERS[idx % 4];
            const text = document.createElement('span');
            text.className = 'option__text';
            text.textContent = label;
            btn.append(letter, text);
            btn.onclick = () => onClick(idx);
            box.appendChild(btn);
        });
    }

    /* ── MP FIX 3: buzz reveal targeted dead #buzzerArea / .ch-option ──
       Reveal is now bulletproof: it runs FIRST (independent of the original
       handler, which could throw), rebuilds the colored options from
       currentMultiQuestion if the box is somehow empty, and forces them
       visible. ── */
    const _chainHandleBuzzed = window.handleBuzzed;
    window.handleBuzzed = function(data) {
        const wrap = document.querySelector('.buzzer-wrap');
        if (wrap) wrap.style.display = 'none';

        const box = document.getElementById('optionsBox');
        if (box) {
            // If the staged-reveal options never got built, rebuild them.
            if (!box.querySelector('.option')) {
                let q = null;
                try { q = (typeof currentMultiQuestion !== 'undefined') ? currentMultiQuestion : null; } catch (e) {}
                if (q && Array.isArray(q.options)) {
                    paintColoredOptions(box, q.options,
                        (idx) => { if (typeof answerQuestion === 'function') answerQuestion(idx); });
                }
            }
            box.style.display = 'grid';
            box.querySelectorAll('.option').forEach(opt => {
                opt.style.opacity = '1';
                opt.style.visibility = 'visible';
            });
        }

        try { if (typeof _chainHandleBuzzed === 'function') _chainHandleBuzzed(data); }
        catch (e) { console.error('handleBuzzed original failed:', e); }
    };

    /* ── MP FIX 4: correct/wrong answer never highlighted ──────
       showResult marked .ch-option nodes (gone). Re-mark the .option
       buttons by their .option__text, and flag the wrong pick by index. ── */
    const _chainShowResult = window.showResult;
    window.showResult = function(data) {
        clearInterval(window._mpTimerInt);
        if (typeof _chainShowResult === 'function') _chainShowResult(data);

        const optionsBox = document.getElementById('optionsBox');
        if (!optionsBox) return;
        optionsBox.style.display = 'grid';
        const wrap = document.querySelector('.buzzer-wrap');
        if (wrap) wrap.style.display = 'none';

        optionsBox.querySelectorAll('.option').forEach((opt, idx) => {
            opt.onclick = null;
            const label = opt.querySelector('.option__text');
            const text = (label ? label.textContent : opt.textContent || '').trim();
            if (data && data.answer && (text === data.answer || text.includes(data.answer))) {
                opt.classList.add('correct');
            }
            if (data && !data.correct && data.selectedIdx !== undefined && idx === data.selectedIdx) {
                opt.classList.add('wrong');
            }
        });
    };

    /* ── SOLO FIX: colored answer pills (cache-proof) ──────────
       Whether game.js renders the old bare <div class="option"> pills or
       the new colored ones, re-paint #soloOptionsBox into the Toybox
       colored buttons after each solo question so solo matches multiplayer.
       Also de-duplicates the "Question QUESTION #1" header pill. ── */
    const _chainSoloQuestion = window.showNextSoloQuestion;
    window.showNextSoloQuestion = function() {
        if (typeof _chainSoloQuestion === 'function') _chainSoloQuestion.apply(this, arguments);

        const box = document.getElementById('soloOptionsBox');
        if (box) {
            const existing = Array.from(box.children);
            const items = existing.map(el => {
                const t = el.querySelector('.option__text');
                return (t ? t.textContent : el.textContent || '')
                    .replace(/^[✅❌]\s*/, '').trim();
            }).filter(s => s.length);
            if (items.length) {
                // True/False keeps its ✅/❌ glyph as the "letter".
                const isTF = items.length === 2 &&
                    items.every(s => /vrai|faux|✅|❌/i.test(s));
                paintColoredOptions(box, items,
                    (idx) => { if (typeof handleSoloAnswer === 'function') handleSoloAnswer(idx); },
                    isTF ? (idx) => (idx === 0 ? '✅' : '❌') : null);
            }
        }

        // Fix the header pill: it already prints "Question ", so the bold
        // value should be just the count (mirror the floating badge).
        const num = document.getElementById('soloQuestionNumber');
        const badgeVal = document.querySelector('#soloQuestionBadge .question-value');
        if (num && badgeVal) num.textContent = badgeVal.textContent;
    };

    /* ── CREATE-ROOM FIX: subject selection was unavailable ────
       The "Modifier" button called a stub that only alerted "bientôt
       disponible", and #createSubjects stayed permanently hidden. Make the
       button reveal the real subject pills and keep the summary count in
       sync. createRoom already reads getSelectedSubjects('createSubjects'). ── */
    function updateCreateSubjectsCount() {
        const label = document.getElementById('createSubjectsCount');
        if (!label) return;
        const sel = (typeof getSelectedSubjects === 'function') ? getSelectedSubjects('createSubjects') : [];
        const total = (typeof SUBJECTS !== 'undefined') ? SUBJECTS.length : sel.length;
        if (!sel.length) label.textContent = 'Aucun sujet';
        else if (sel.length >= total) label.textContent = 'Tous les sujets';
        else label.textContent = sel.length + ' sujet' + (sel.length > 1 ? 's' : '');
    }

    window.openSubjectsPicker = function() {
        const box = document.getElementById('createSubjects');
        if (!box) return;
        // Ensure the pills exist (render only once).
        if (!box.querySelector('.subject-pill') && typeof renderSubjectsToContainer === 'function') {
            renderSubjectsToContainer('createSubjects');
        }
        box.classList.toggle('hidden');
        // Recompute the summary count whenever a pill is toggled (wire once).
        if (!box.dataset.countWired) {
            box.addEventListener('click', () => setTimeout(updateCreateSubjectsCount, 0));
            box.dataset.countWired = '1';
        }
        updateCreateSubjectsCount();
        const btn = document.querySelector('.row-block__action');
        if (btn) btn.textContent = box.classList.contains('hidden') ? 'Modifier' : 'Terminer';
    };

    // Keep the summary count correct once the create screen has rendered pills.
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(updateCreateSubjectsCount, 400);
    });

    /* ── FIX: spacebar buzz was advertised ("ou tapez espace") but no key
       handler existed. Bind it — only on the active game screen, only when
       not typing in a field, and only if the buzzer is enabled. ── */
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space' && e.key !== ' ' && e.key !== 'Spacebar') return;
        const el = e.target;
        const tag = (el && el.tagName) || '';
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (el && el.isContentEditable)) return;
        const gameScreen = document.getElementById('gameScreen');
        if (!gameScreen || !gameScreen.classList.contains('active')) return;
        const buzzer = document.getElementById('buzzer');
        if (!buzzer || buzzer.disabled) return;
        e.preventDefault();
        if (typeof buzzerPressed === 'function') buzzerPressed();
    });

})();
