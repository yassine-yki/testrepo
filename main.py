import uuid, random, json, asyncio, time, os, re
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from typing import Dict, Any, Optional, List

# === SCORING CONFIGURATION ===
WRONG_ANSWER_PENALTY = 50     # Points lost for wrong answer
TIMEOUT_PENALTY = 50          # Points lost for timeout
MIN_CORRECT_POINTS = 10       # Minimum points for correct answer (slow response)
MAX_CORRECT_POINTS = 100      # Maximum points for correct answer (instant response)

def calculate_time_score(time_left: float, max_time: float) -> int:
    """Calculate score based on remaining time"""
    if max_time <= 0:
        return MIN_CORRECT_POINTS
    time_ratio = max(0, min(1, time_left / max_time))
    score = int(MIN_CORRECT_POINTS + (MAX_CORRECT_POINTS - MIN_CORRECT_POINTS) * time_ratio)
    return score

# ============================================
# ADAPTIVE DIFFICULTY ENGINE
# ============================================

# Difficulty levels and their modifiers
DIFFICULTY_LEVELS = {
    "easy":   {"timer_bonus": 5, "score_multiplier": 0.8, "target_difficulty": 1},
    "medium": {"timer_bonus": 0, "score_multiplier": 1.0, "target_difficulty": 2},
    "hard":   {"timer_bonus": -3, "score_multiplier": 1.5, "target_difficulty": 3},
}

def create_adaptive_state():
    """Create fresh adaptive difficulty state"""
    return {
        "history": [],          # rolling window of results (1=correct, 0=wrong)
        "level": "medium",      # current difficulty level
        "streak": 0,            # current correct streak (negative = wrong streak)
        "questions_answered": 0,
        "avg_response_time": 0.0,
        "response_times": [],   # rolling window of response times
    }

def update_adaptive_state(state, correct: bool, response_time: float):
    """Update adaptive state after an answer"""
    WINDOW = 5  # rolling window size
    
    state["history"].append(1 if correct else 0)
    if len(state["history"]) > WINDOW:
        state["history"] = state["history"][-WINDOW:]
    
    state["response_times"].append(response_time)
    if len(state["response_times"]) > WINDOW:
        state["response_times"] = state["response_times"][-WINDOW:]
    
    state["avg_response_time"] = sum(state["response_times"]) / len(state["response_times"])
    state["questions_answered"] += 1
    
    # Update streak
    if correct:
        state["streak"] = max(0, state["streak"]) + 1
    else:
        state["streak"] = min(0, state["streak"]) - 1
    
    # Calculate performance ratio from rolling window
    if len(state["history"]) >= 3:  # Need at least 3 answers before adapting
        ratio = sum(state["history"]) / len(state["history"])
        
        current = state["level"]
        if ratio > 0.8 and state["streak"] >= 3:
            # Doing great — increase difficulty
            if current == "easy": state["level"] = "medium"
            elif current == "medium": state["level"] = "hard"
        elif ratio < 0.4 or state["streak"] <= -2:
            # Struggling — decrease difficulty
            if current == "hard": state["level"] = "medium"
            elif current == "medium": state["level"] = "easy"
    
    return state

def get_adaptive_modifiers(state):
    """Get timer and score modifiers for current difficulty level"""
    return DIFFICULTY_LEVELS.get(state["level"], DIFFICULTY_LEVELS["medium"])

def get_room_collective_state(room):
    """Compute collective adaptive state for multiplayer rooms"""
    if "adaptive_room" not in room:
        room["adaptive_room"] = create_adaptive_state()
    return room["adaptive_room"]

def update_room_collective(room, num_correct: int, num_active: int, avg_response_time: float):
    """Update room-level adaptive state based on collective performance"""
    state = get_room_collective_state(room)
    # Treat the room performance as a single "player"
    room_correct = num_correct / max(1, num_active) > 0.5  # majority got it right
    update_adaptive_state(state, room_correct, avg_response_time)
    return state

def select_question_by_difficulty(questions, target_difficulty):
    """Select a question matching the target difficulty, with fallback"""
    # Separate questions by difficulty tag
    tagged = [q for q in questions if "difficulty" in q]
    untagged = [q for q in questions if "difficulty" not in q]
    
    if not tagged:
        # No difficulty tags — pick randomly from all
        return random.choice(questions) if questions else None
    
    # Try exact match first
    exact = [q for q in tagged if q["difficulty"] == target_difficulty]
    if exact:
        return random.choice(exact)
    
    # Try adjacent difficulty
    adjacent = [q for q in tagged if abs(q["difficulty"] - target_difficulty) <= 1]
    if adjacent:
        return random.choice(adjacent)
    
    # Fallback to any tagged + untagged
    return random.choice(tagged + untagged)

# Load environment variables from .env file (for local development)
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("✅ Loaded .env file")
except ImportError:
    print("ℹ️  python-dotenv not installed, using system environment variables")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory="templates")

# === HUGGING FACE CONFIGURATION ===
# Token is loaded from environment variable (never hardcode secrets!)
HF_API_TOKEN = os.environ.get("HF_API_TOKEN")
HF_API_URL = "https://router.huggingface.co/v1/chat/completions"
HF_MODEL = "meta-llama/Llama-3.1-8B-Instruct"

# Warning if token is not set
if not HF_API_TOKEN:
    print("⚠️  WARNING: HF_API_TOKEN environment variable is not set!")
    print("   AI-generated questions will not work.")
    print("   Set it with: export HF_API_TOKEN='your_token_here'")

# Cache file path
CACHE_FILE = "ai_questions_cache.json"

# Cache for AI-generated questions
ai_questions_cache: Dict[str, List[Dict]] = {}

# Load cache from file on startup
def load_cache_from_file():
    global ai_questions_cache
    try:
        if os.path.exists(CACHE_FILE):
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                ai_questions_cache = json.load(f)
                total_questions = sum(len(q) for q in ai_questions_cache.values())
                print(f"✅ Loaded {total_questions} cached questions from {len(ai_questions_cache)} categories")
    except Exception as e:
        print(f"⚠️ Could not load cache: {e}")
        ai_questions_cache = {}

# Save cache to file
def save_cache_to_file():
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(ai_questions_cache, f, ensure_ascii=False, indent=2)
        print(f"💾 Cache saved: {sum(len(q) for q in ai_questions_cache.values())} questions")
    except Exception as e:
        print(f"⚠️ Could not save cache: {e}")

# Load cache on startup
load_cache_from_file()

# === TRANSLATIONS ===
TRANSLATIONS = {
    "en": {
        "room_exists": "Room already exists",
        "room_not_found": "Room not found",
        "invalid_name": "Invalid name",
        "name_taken": "Name taken",
        "invalid_credentials": "Invalid credentials",
        "only_host_start": "Only the host can start the game",
        "need_players": "Need at least 2 players",
        "game_started": "Game already started",
        "game_starting": "{player} started the game!",
        "not_enough_players": "Not enough players",
        "all_questions_completed": "All questions completed",
        "player_left": "{player} left the game",
        "new_host": "{host} is now the host",
        "correct": "✅ Correct!",
        "wrong": "❌ Wrong! Answer: {answer}",
        "timeout": "⏰ Time's up!",
        "buzzed": "🔔 {player} buzzed!",
        "round_complete": "Round {round} Complete!",
        "player_eliminated": "{player} has been eliminated!",
        "final_round": "Final Round!",
        "round_starting": "Round {round} Starting...",
        "team_eliminated": "Team {team} has been eliminated!",
        "need_four_players": "Need exactly 4 players for team mode",
        "team_full": "That team is full (max 2 players per team)",
        "select_team": "Select Your Team:",
        "team_red": "Red Team",
        "team_blue": "Blue Team",
        "player_reconnected": "{player} reconnected!",
        "reconnect_expired": "Reconnection window expired",
        "rematch_starting": "Rematch starting! Returning to lobby...",
        "room_full": "Room is full"
    },
    "fr": {
        "room_exists": "La salle existe déjà",
        "room_not_found": "Salle non trouvée",
        "invalid_name": "Nom invalide",
        "name_taken": "Nom déjà pris",
        "invalid_credentials": "Identifiants invalides",
        "only_host_start": "Seul l'hôte peut démarrer le jeu",
        "need_players": "Au moins 2 joueurs nécessaires",
        "game_started": "Jeu déjà commencé",
        "game_starting": "{player} a démarré le jeu !",
        "not_enough_players": "Pas assez de joueurs",
        "all_questions_completed": "Toutes les questions terminées",
        "player_left": "{player} a quitté le jeu",
        "new_host": "{host} est maintenant l'hôte",
        "correct": "✅ Correct !",
        "wrong": "❌ Faux ! Réponse : {answer}",
        "timeout": "⏰ Temps écoulé !",
        "buzzed": "🔔 {player} a buzzer !",
        "round_complete": "Manche {round} Terminée !",
        "player_eliminated": "{player} a été éliminé !",
        "final_round": "Manche Finale !",
        "round_starting": "Manche {round} Commence...",
        "team_eliminated": "Équipe {team} a été éliminée !",
        "need_four_players": "Exactement 4 joueurs nécessaires pour le mode équipe",
        "team_full": "Cette équipe est pleine (max 2 joueurs par équipe)",
        "select_team": "Sélectionnez votre équipe:",
        "team_red": "Équipe Rouge",
        "team_blue": "Équipe Bleue",
        "player_reconnected": "{player} s'est reconnecté !",
        "reconnect_expired": "Délai de reconnexion expiré",
        "rematch_starting": "Revanche ! Retour au lobby...",
        "room_full": "La salle est pleine"
    }
}

def get_text(lang: str, key: str, **kwargs) -> str:
    text = TRANSLATIONS.get(lang, TRANSLATIONS["en"]).get(key, key)
    if kwargs:
        text = text.format(**kwargs)
    return text

# === LOAD QUESTIONS ===
try:
    with open("questions.json", "r", encoding="utf-8") as f:
        ALL_QUESTIONS = json.load(f)
except FileNotFoundError:
    raise RuntimeError("questions.json not found")

# Load flag questions and merge with ALL_QUESTIONS
try:
    with open("flag_questions.json", "r", encoding="utf-8") as f:
        FLAG_QUESTIONS = json.load(f)
    # Merge flag questions into ALL_QUESTIONS
    for lang in FLAG_QUESTIONS:
        if lang not in ALL_QUESTIONS:
            ALL_QUESTIONS[lang] = {}
        ALL_QUESTIONS[lang]["flags"] = FLAG_QUESTIONS[lang]["flags"]
    print(f"✅ Loaded {len(FLAG_QUESTIONS.get('en', {}).get('flags', []))} flag questions")
except FileNotFoundError:
    print("⚠️ flag_questions.json not found, flag quiz disabled")
except Exception as e:
    print(f"⚠️ Error loading flag questions: {e}")

# Load image riddles and replace text riddles
try:
    with open("image_riddles.json", "r", encoding="utf-8") as f:
        IMAGE_RIDDLES = json.load(f)
    # Replace riddles with image_riddles in ALL_QUESTIONS
    for lang in IMAGE_RIDDLES:
        if lang not in ALL_QUESTIONS:
            ALL_QUESTIONS[lang] = {}
        # Remove old text riddles if they exist
        if "riddles" in ALL_QUESTIONS.get(lang, {}):
            del ALL_QUESTIONS[lang]["riddles"]
        # Add image riddles as the new riddles category
        ALL_QUESTIONS[lang]["image_riddles"] = IMAGE_RIDDLES[lang]["image_riddles"]
    print(f"✅ Loaded {len(IMAGE_RIDDLES.get('en', {}).get('image_riddles', []))} image riddles")
except FileNotFoundError:
    print("⚠️ image_riddles.json not found, keeping text riddles")
except Exception as e:
    print(f"⚠️ Error loading image riddles: {e}")

# Load picture guess questions
try:
    with open("picguess_questions.json", "r", encoding="utf-8") as f:
        PICGUESS_QUESTIONS = json.load(f)
    for lang in PICGUESS_QUESTIONS:
        if lang not in ALL_QUESTIONS:
            ALL_QUESTIONS[lang] = {}
        ALL_QUESTIONS[lang]["picguess"] = PICGUESS_QUESTIONS[lang]["picguess"]
    print(f"✅ Loaded {len(PICGUESS_QUESTIONS.get('en', {}).get('picguess', []))} picture guess questions")
except FileNotFoundError:
    print("⚠️ picguess_questions.json not found, picture guess disabled")
except Exception as e:
    print(f"⚠️ Error loading picture guess questions: {e}")

# === GLOBAL STATE ===
rooms: Dict[str, Dict] = {}
connections: Dict[str, Dict[str, WebSocket]] = {}
room_locks: Dict[str, asyncio.Lock] = {}
disconnected_players: Dict[str, Dict[str, Dict]] = {}  # code -> {user_id -> {player_data, disconnected_at, match_token}}

RECONNECT_WINDOW = 60  # seconds a player can reconnect after disconnect
# === HELPERS ===
def get_room(code: str) -> Optional[Dict]:
    return rooms.get(code)

def get_public_rooms() -> List[Dict]:
    """Get list of public rooms that are waiting for players"""
    public_rooms = []
    for code, room in rooms.items():
        if room.get("is_public", False) and room.get("state") == "waiting":
            public_rooms.append({
                "code": code,
                "hostName": room["players"][room["host"]]["name"] if room["host"] and room["host"] in room["players"] else "Unknown",
                "playerCount": len(room["players"]),
                "gameMode": room.get("game_mode", "ffa"),
                "maxPlayers": 4
            })
    return public_rooms

async def broadcast_public_rooms():
    """Broadcast updated public rooms list to all clients in the lobby"""
    public_rooms = get_public_rooms()
    # Broadcast to all connections waiting in lobby (code = "LOBBY")
    for user_id, ws in connections.get("LOBBY", {}).items():
        try:
            await ws.send_json({"event": "publicRooms", "data": public_rooms})
        except Exception as e:
            print(f"Error broadcasting public rooms to {user_id}: {e}")

async def broadcast(code: str, event: str, data: Any, exclude: Optional[str] = None):
    for user_id, ws in connections.get(code, {}).items():
        if exclude and user_id == exclude:
            continue
        try:
            await ws.send_json({"event": event, "data": data})
        except Exception as e:
            print(f"Error broadcasting to {user_id}: {e}")

async def send_to_user(code: str, user_id: str, event: str, data: Any):
    ws = connections.get(code, {}).get(user_id)
    if ws:
        try:
            await ws.send_json({"event": event, "data": data})
        except Exception as e:
            print(f"Error sending to {user_id}: {e}")

def validate_player_name(name: str) -> bool:
    if not name or not isinstance(name, str):
        return False
    name = name.strip()
    return 1 <= len(name) <= 20 and name.isprintable()

async def cleanup_room(code: str):
    was_public = rooms.get(code, {}).get("is_public", False)
    rooms.pop(code, None)
    connections.pop(code, None)
    room_locks.pop(code, None)
    disconnected_players.pop(code, None)
    # Notify lobby if it was a public room
    if was_public:
        await broadcast_public_rooms()

def purge_expired_disconnects(code: str):
    """Remove expired disconnection entries for a room"""
    if code not in disconnected_players:
        return
    now = time.time()
    expired = [uid for uid, data in disconnected_players[code].items()
               if now - data["disconnected_at"] > RECONNECT_WINDOW]
    for uid in expired:
        disconnected_players[code].pop(uid, None)
    if not disconnected_players[code]:
        disconnected_players.pop(code, None)

async def end_game(code: str):
    """Mark room as gameOver but keep it alive for rematch"""
    room = get_room(code)
    if room:
        room["state"] = "gameOver"
        # Schedule auto-cleanup after 5 minutes if no rematch
        asyncio.create_task(_auto_cleanup_gameover(code))

async def _auto_cleanup_gameover(code: str):
    """Clean up a gameOver room after 5 minutes if no rematch happened"""
    await asyncio.sleep(300)  # 5 minutes
    room = get_room(code)
    if room and room.get("state") == "gameOver":
        await cleanup_room(code)

def reset_room_for_rematch(code: str):
    """Reset room state for a rematch — keeps players, resets scores and game state"""
    room = get_room(code)
    if not room:
        return False
    
    # Reset all player scores and mark active
    for uid, player in room["players"].items():
        player["score"] = 0
        player["active"] = True
    
    # Reset team scores if team mode
    if room["teams"]:
        for team_name in room["teams"]:
            room["teams"][team_name]["score"] = 0
            room["teams"][team_name]["active"] = True
    
    # Reset game state
    room["state"] = "waiting"
    room["current_q"] = None
    room["timer"] = 0
    room["buzzed"] = None
    room["answered"] = False
    room["available"] = []
    room["current_round"] = 1
    room["questions_in_round"] = 0
    
    # Clear disconnected players for this room
    disconnected_players.pop(code, None)
    
    return True

async def timer_task(code: str):
    room = get_room(code)
    if not room:
        return
    
    start_time = time.time()
    duration = room["timer"]
    
    while time.time() - start_time < duration:
        if room["answered"] or code not in rooms:
            return
        await asyncio.sleep(0.1)
    
    # Time's up - handle both buzzed and no-buzz cases
    if not room["answered"]:
        async with room_locks[code]:
            if not room["answered"]:
                room["answered"] = True
                q = room["current_q"]
                lang = room.get("language", "en")
                
                # If someone buzzed but didn't answer in time, apply penalty
                if room["buzzed"]:
                    buzzed_player = room["players"].get(room["buzzed"])
                    if buzzed_player:
                        buzzed_player["score"] -= TIMEOUT_PENALTY  # Allow negative
                        # Deduct from team if team mode
                        if room["game_mode"] == "team" and buzzed_player.get("team"):
                            room["teams"][buzzed_player["team"]]["score"] -= TIMEOUT_PENALTY
                
                await broadcast(code, "answerResult", {
                    "correct": False,
                    "answer": q["options"][q["correct"]],
                    "scores": {p["name"]: p["score"] for p in room["players"].values()},
                    "timeout": True,
                    "message": get_text(lang, "timeout"),
                    "teamScores": room.get("teams") if room["game_mode"] == "team" else None,
                    "pointsEarned": -TIMEOUT_PENALTY if room["buzzed"] else 0
                })
                
                await asyncio.sleep(3)
                await next_question(code)

async def eliminate_lowest_player(code: str):
    """Eliminate the player with the lowest score"""
    room = get_room(code)
    if not room:
        return False
    
    lang = room.get("language", "en")
    
    # Get active players only
    active_players = {uid: p for uid, p in room["players"].items() if p.get("active", True)}
    
    if len(active_players) <= 1:
        # Only one player left - they win! END GAME IMMEDIATELY
        winner = list(active_players.values())[0] if active_players else None
        await broadcast(code, "gameOver", {
            "reason": get_text(lang, "all_questions_completed"),
            "winner": winner["name"] if winner else None,
            "finalScores": {p["name"]: p["score"] for p in room["players"].values()}
        })
        await end_game(code)
        return True  # Signal that game ended
    
    # Find player with lowest score
    lowest_player_id = min(active_players.keys(), key=lambda uid: active_players[uid]["score"])
    lowest_player = room["players"][lowest_player_id]
    
    # Mark player as eliminated (not active)
    lowest_player["active"] = False
    
    # Broadcast elimination
    await broadcast(code, "playerEliminated", {
        "player": lowest_player["name"],
        "score": lowest_player["score"],
        "message": get_text(lang, "player_eliminated", player=lowest_player["name"]),
        "scores": {p["name"]: p["score"] for p in room["players"].values()},
        "activePlayers": [p["name"] for uid, p in room["players"].items() if p.get("active", True)]
    })
    
    # Check again after elimination
    remaining_active = {uid: p for uid, p in room["players"].items() if p.get("active", True)}
    if len(remaining_active) == 1:
        # Only one player remains after elimination - END GAME
        winner = list(remaining_active.values())[0]
        await asyncio.sleep(3)  # Brief pause after elimination message
        await broadcast(code, "gameOver", {
            "reason": get_text(lang, "all_questions_completed"),
            "winner": winner["name"],
            "finalScores": {p["name"]: p["score"] for p in room["players"].values()}
        })
        await end_game(code)
        return True  # Signal that game ended
    
    return False  # Game continues

async def eliminate_lowest_team(code: str):
    """Eliminate the team with the lowest score"""
    room = get_room(code)
    if not room:
        return False
    
    lang = room.get("language", "en")
    teams = room.get("teams")
    
    if not teams:
        return False
    
    # Get active teams
    active_teams = {name: team for name, team in teams.items() if team.get("active", True)}
    
    if len(active_teams) <= 1:
        # Only one team left
        winner_team = list(active_teams.keys())[0] if active_teams else None
        team_name = get_text(lang, f"team_{winner_team}")
        
        await broadcast(code, "gameOver", {
            "reason": get_text(lang, "all_questions_completed"),
            "winner": team_name,
            "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
            "teamScores": teams
        })
        await end_game(code)
        return True
    
    # Find team with lowest score
    lowest_team = min(active_teams.keys(), key=lambda t: active_teams[t]["score"])
    teams[lowest_team]["active"] = False
    
    # Mark all players in that team as eliminated
    for uid, player in room["players"].items():
        if player.get("team") == lowest_team:
            player["active"] = False
    
    team_name = get_text(lang, f"team_{lowest_team}")
    
    await broadcast(code, "teamEliminated", {
        "team": lowest_team,
        "teamName": team_name,
        "message": get_text(lang, "team_eliminated", team=team_name),
        "scores": {p["name"]: p["score"] for p in room["players"].values()},
        "teamScores": teams
    })
    
    # Check if only one team remains
    remaining_teams = {name: team for name, team in teams.items() if team.get("active", True)}
    if len(remaining_teams) == 1:
        winner_team = list(remaining_teams.keys())[0]
        team_name = get_text(lang, f"team_{winner_team}")
        await asyncio.sleep(3)
        await broadcast(code, "gameOver", {
            "reason": get_text(lang, "all_questions_completed"),
            "winner": team_name,
            "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
            "teamScores": teams
        })
        await end_game(code)
        return True
    
    return False

async def start_next_round(code: str):
    """Start the next round"""
    room = get_room(code)
    if not room:
        return
    
    lang = room.get("language", "en")
    
    # Check if only one player/team remains
    if room["game_mode"] == "team":
        active_teams = {name: team for name, team in room["teams"].items() if team.get("active", True)}
        if len(active_teams) <= 1:
            winner_team = list(active_teams.keys())[0] if active_teams else None
            team_name = get_text(lang, f"team_{winner_team}") if winner_team else None
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "winner": team_name,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
                "teamScores": room["teams"]
            })
            await end_game(code)
            return
    else:
        active_players = {uid: p for uid, p in room["players"].items() if p.get("active", True)}
        if len(active_players) <= 1:
            winner = list(active_players.values())[0] if active_players else None
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "winner": winner["name"] if winner else None,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()}
            })
            await end_game(code)
            return
    
    # Increment round
    room["current_round"] += 1
    room["questions_in_round"] = 0
    
    if room["current_round"] > room["max_rounds"]:
        # Game over - find winner
        if room["game_mode"] == "team":
            active_teams = {name: team for name, team in room["teams"].items() if team.get("active", True)}
            winner_team = max(active_teams.keys(), key=lambda t: active_teams[t]["score"]) if active_teams else None
            team_name = get_text(lang, f"team_{winner_team}") if winner_team else None
            
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "winner": team_name,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
                "teamScores": room["teams"]
            })
        else:
            active_players = {uid: p for uid, p in room["players"].items() if p.get("active", True)}
            winner = max(active_players.values(), key=lambda p: p["score"], default=None) if active_players else None
            
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "winner": winner["name"] if winner else None,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()}
            })
        await end_game(code)
        return
    
    # Show round transition
    round_msg = get_text(lang, "final_round") if room["current_round"] == room["max_rounds"] else get_text(lang, "round_starting", round=room["current_round"])
    
    await broadcast(code, "roundTransition", {
        "round": room["current_round"],
        "maxRounds": room["max_rounds"],
        "message": round_msg,
        "scores": {p["name"]: p["score"] for p in room["players"].values()},
        "activePlayers": [p["name"] for uid, p in room["players"].items() if p.get("active", True)],
        "teamScores": room.get("teams") if room["game_mode"] == "team" else None
    })
    
    await asyncio.sleep(3)
    await start_question(code)

# === ROUTES ===
@app.get("/")
async def landing(request: Request):
    return templates.TemplateResponse("landing.html", {"request": request})

@app.get("/game")
async def game(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/questions")
async def get_questions(language: str = "en", subjects: str = ""):
    subject_list = [s.strip() for s in subjects.split(",") if s.strip()]
    
    if not subject_list:
        subject_list = list(ALL_QUESTIONS.get(language, {}).keys())
    
    questions = []
    for subject in subject_list:
        if subject in ALL_QUESTIONS.get(language, {}):
            questions.extend(ALL_QUESTIONS[language][subject])
    
    random.shuffle(questions)
    return {"questions": questions[:20]}

@app.get("/api/public-rooms")
async def get_public_rooms_api():
    """API endpoint to get list of public rooms"""
    return {"rooms": get_public_rooms()}

# === WEBSOCKET ===
@app.websocket("/ws/{code}")
async def websocket_endpoint(ws: WebSocket, code: str):
    await ws.accept()
    code = code.upper()[:6]
    user_id = None
    
    try:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")

            # === LOBBY ACTIONS ===
            if action == "joinLobby":
                # Join the lobby to receive public room updates
                user_id = str(uuid.uuid4())
                if "LOBBY" not in connections:
                    connections["LOBBY"] = {}
                connections["LOBBY"][user_id] = ws
                
                # Send current public rooms
                await ws.send_json({"event": "publicRooms", "data": get_public_rooms()})

            elif action == "leaveLobby":
                # Leave the lobby
                if user_id and "LOBBY" in connections:
                    connections["LOBBY"].pop(user_id, None)

            elif action == "create":
                # Remove from lobby if was there
                if user_id and "LOBBY" in connections:
                    connections["LOBBY"].pop(user_id, None)
                
                if code in rooms:
                    lang = msg.get("language", "en")
                    await ws.send_json({"event": "error", "data": get_text(lang, "room_exists")})
                    continue
                
                language = msg.get("language", "en")
                subjects = msg.get("subjects", [])
                game_mode = msg.get("gameMode", "ffa")
                is_public = msg.get("isPublic", False)  # NEW: Public room option
                ai_questions = msg.get("aiQuestions", None)  # NEW: AI-generated questions
                quiz_type = msg.get("quizType", "classic")  # NEW: classic, truefalse, picguess, speed
                
                # Debug logging
                print(f"Creating room {code}")
                print(f"AI Questions received: {ai_questions is not None}")
                print(f"Quiz type: {quiz_type}")
                if ai_questions:
                    print(f"Number of AI questions: {len(ai_questions)}")
                
                rooms[code] = {
                    "players": {},
                    "current_q": None,
                    "timer": 0,
                    "buzzed": None,
                    "answered": False,
                    "available": [],
                    "created_at": time.time(),
                    "state": "waiting",
                    "host": None,
                    "language": language,
                    "subjects": subjects,
                    "current_round": 1,
                    "questions_in_round": 0,
                    "max_rounds": 3,
                    "questions_per_round": 5 if quiz_type != "speed" else 10,
                    "game_mode": game_mode,
                    "is_public": is_public,  # NEW: Store public status
                    "ai_questions": ai_questions,  # NEW: Store AI questions
                    "quiz_type": quiz_type,  # NEW: Store quiz type
                    "teams": {"red": {"score": 0, "active": True}, "blue": {"score": 0, "active": True}} if game_mode == "team" else None,
                    "adaptive_room": create_adaptive_state(),  # Collective difficulty for multiplayer
                }
                connections[code] = {}
                room_locks[code] = asyncio.Lock()
                
                await ws.send_json({"event": "roomCreated", "data": {"code": code, "language": language, "gameMode": game_mode, "isPublic": is_public}})
                
                # Notify lobby about new public room
                if is_public:
                    await broadcast_public_rooms()

            
            elif action == "getRoomInfo":
              room = get_room(code)
              if not room:
                 await ws.send_json({"event": "error", "data": "Room not found"})
                 await ws.close()
                 return
              
              # Calculate team counts
              team_counts = None
              if room["game_mode"] == "team":
                  team_counts = {
                      "red": sum(1 for p in room["players"].values() if p.get("team") == "red"),
                      "blue": sum(1 for p in room["players"].values() if p.get("team") == "blue")
                                }
              await ws.send_json({
                  "event": "roomInfo",
                  "data": {
                     "gameMode": room["game_mode"],
                     "playerCount": len(room["players"]),
                     "teamCounts": team_counts
                          }
                                 })
              await asyncio.sleep(0.1)
              await ws.close()  # Close temp connection
              return
            
            elif action == "join":
                # Remove from lobby if was there
                if user_id and "LOBBY" in connections:
                    connections["LOBBY"].pop(user_id, None)
                
                room = get_room(code)
                if not room:
                    lang = msg.get("language", "en")
                    await ws.send_json({"event": "error", "data": get_text(lang, "room_not_found")})
                    continue

                lang = room.get("language", "en")
                name = msg.get("playerName", "").strip()
                selected_team = msg.get("team")
                avatar_config = msg.get("avatar")  # Get avatar from client
                
                # Check 4-player maximum limit
                MAX_PLAYERS = 4
                if len(room["players"]) >= MAX_PLAYERS:
                    await ws.send_json({"event": "error", "data": get_text(lang, "room_full")})
                    continue
                
                if not validate_player_name(name):
                    await ws.send_json({"event": "error", "data": get_text(lang, "invalid_name")})
                    continue

                if any(p["name"].lower() == name.lower() for p in room["players"].values()):
                    await ws.send_json({"event": "error", "data": get_text(lang, "name_taken")})
                    continue

                user_id = str(uuid.uuid4())
                match_token = uuid.uuid4().hex
                
                # Assign team if team mode
                team = None
                if room["game_mode"] == "team":
                   if selected_team and selected_team in ["red", "blue"]:
                         # Check if team is full (max 2 players per team)
                         team_count = sum(1 for p in room["players"].values() if p.get("team") == selected_team)
                         if team_count >= 2:
                          await ws.send_json({"event": "error", "data": get_text(lang, "team_full")})
                          continue
                         team = selected_team
                   else:
                         # Auto-assign to team with fewer players
                         red_count = sum(1 for p in room["players"].values() if p.get("team") == "red")
                         blue_count = sum(1 for p in room["players"].values() if p.get("team") == "blue")
                         team = "red" if red_count <= blue_count else "blue"

                room["players"][user_id] = {
                    "name": name,
                    "match_token": match_token,
                    "score": 0,
                    "joined_at": time.time(),
                    "active": True,
                    "connected": True,
                    "team": team,
                    "avatar": avatar_config,
                    "adaptive": create_adaptive_state(),  # Per-player adaptive difficulty (solo)
                }
                
                if room["host"] is None:
                    room["host"] = user_id
                
                connections[code][user_id] = ws

                await ws.send_json({
                    "event": "joined",
                    "data": {
                        "userId": user_id,
                        "matchToken": match_token,
                        "isHost": user_id == room["host"],
                        "language": lang,
                        "team": team
                    }
                })

                # Determine if can start (2-4 players for FFA, exactly 4 for team)
                can_start = False
                if room["game_mode"] == "team":
                    red_count = sum(1 for p in room["players"].values() if p.get("team") == "red")
                    blue_count = sum(1 for p in room["players"].values() if p.get("team") == "blue")
                    can_start = len(room["players"]) == 4 and red_count == 2 and blue_count == 2
                else:
                    can_start = len(room["players"]) >= 2 and len(room["players"]) <= MAX_PLAYERS

                await broadcast(code, "players", {
                    "players": [
                        {
                            "name": p["name"], 
                            "score": p["score"],
                            "isHost": uid == room["host"],
                            "team": p.get("team"),
                            "avatar": p.get("avatar")  # Include avatar in broadcast
                        }
                        for uid, p in room["players"].items()
                    ],
                    "count": len(room["players"]),
                    "maxPlayers": MAX_PLAYERS,
                    "canStart": can_start,
                    "gameMode": room["game_mode"],
                    "teamCounts": {
                        "red": sum(1 for p in room["players"].values() if p.get("team") == "red"),
                        "blue": sum(1 for p in room["players"].values() if p.get("team") == "blue")
                }   if room["game_mode"] == "team" else None
                     })
                
                # Notify lobby about updated player count
                if room.get("is_public"):
                    await broadcast_public_rooms()

            elif action == "start":
                room = get_room(code)
                if not room:
                    continue
                
                lang = room.get("language", "en")
                msg_user_id = msg.get("userId")
                token = msg.get("matchToken")
                
                player = room["players"].get(msg_user_id)
                if not player or player["match_token"] != token:
                    await ws.send_json({"event": "error", "data": get_text(lang, "invalid_credentials")})
                    continue
                
                if msg_user_id != room["host"]:
                    await ws.send_json({"event": "error", "data": get_text(lang, "only_host_start")})
                    continue
                
                # Check player count based on game mode
                if room["game_mode"] == "team":
                    if len(room["players"]) != 4:
                        await ws.send_json({"event": "error", "data": get_text(lang, "need_four_players")})
                        continue
                else:
                    if len(room["players"]) < 2:
                        await ws.send_json({"event": "error", "data": get_text(lang, "need_players")})
                        continue
                
                if room["state"] != "waiting":
                    await ws.send_json({"event": "error", "data": get_text(lang, "game_started")})
                    continue
                
                room["state"] = "question"
                
                # Remove from public rooms since game started
                if room.get("is_public"):
                    await broadcast_public_rooms()
                
                await broadcast(code, "gameStarting", {
                    "startedBy": player["name"],
                    "message": get_text(lang, "game_starting", player=player["name"])
                })
                await asyncio.sleep(2)
                await start_question(code)

            elif action == "buzz":
                room = get_room(code)
                if not room:
                    continue
                
                msg_user_id = msg.get("userId")
                token = msg.get("matchToken")
                lang = room.get("language", "en")

                player = room["players"].get(msg_user_id)
                if not player or player["match_token"] != token:
                    continue
                
                if not player.get("active", True):
                    await send_to_user(code, msg_user_id, "error", "You have been eliminated and cannot buzz")
                    continue

                async with room_locks[code]:
                    if room["state"] != "question" or room["buzzed"] or room["answered"]:
                        continue

                    room["buzzed"] = msg_user_id
                    room["state"] = "buzzed"
                    
                    await broadcast(code, "buzzed", {
                        "player": player["name"],
                        "message": get_text(lang, "buzzed", player=player["name"])
                    })

            elif action == "reaction":
                # Handle player reactions (emoji reactions during game)
                room = get_room(code)
                if not room:
                    continue
                
                msg_user_id = msg.get("userId")
                token = msg.get("matchToken")
                emoji = msg.get("emoji", "")

                player = room["players"].get(msg_user_id)
                if not player or player["match_token"] != token:
                    continue
                
                # Broadcast reaction to all players except sender
                for uid, p in room["players"].items():
                    if uid != msg_user_id and uid in connections.get(code, {}):
                        try:
                            await connections[code][uid].send_json({
                                "event": "reaction",
                                "data": {
                                    "player": player["name"],
                                    "emoji": emoji
                                }
                            })
                        except:
                            pass

            elif action == "rejoin":
                # Reconnection — player reconnects with stored credentials
                rejoin_token = msg.get("matchToken")
                rejoin_user_id = msg.get("userId")
                
                room = get_room(code)
                if not room:
                    await ws.send_json({"event": "error", "data": "Room no longer exists"})
                    continue
                
                lang = room.get("language", "en")
                
                # Check if this player is in the disconnected pool
                purge_expired_disconnects(code)
                disc_entry = disconnected_players.get(code, {}).get(rejoin_user_id)
                
                if not disc_entry or disc_entry["match_token"] != rejoin_token:
                    # Also check if player is still in room but marked disconnected
                    player = room["players"].get(rejoin_user_id)
                    if player and player.get("match_token") == rejoin_token and not player.get("connected", True):
                        # Valid — restore connection
                        player["connected"] = True
                        connections[code][rejoin_user_id] = ws
                        user_id = rejoin_user_id
                        
                        # Clean up disconnected entry
                        if code in disconnected_players:
                            disconnected_players[code].pop(rejoin_user_id, None)
                        
                        await ws.send_json({"event": "rejoined", "data": {
                            "userId": rejoin_user_id,
                            "matchToken": rejoin_token,
                            "isHost": rejoin_user_id == room["host"],
                            "team": player.get("team"),
                            "score": player["score"],
                            "gameState": room["state"],
                            "language": lang,
                            "roomCode": code
                        }})
                        
                        await broadcast(code, "playerReconnected", {
                            "player": player["name"],
                            "message": get_text(lang, "player_reconnected", player=player["name"])
                        }, exclude=rejoin_user_id)
                    else:
                        await ws.send_json({"event": "rejoinFailed", "data": get_text(lang, "reconnect_expired")})
                    continue
                
                # Restore from disconnected pool
                player_data = disc_entry["player_data"]
                player_data["connected"] = True
                
                # Player should still be in room["players"] (marked disconnected)
                if rejoin_user_id in room["players"]:
                    room["players"][rejoin_user_id]["connected"] = True
                else:
                    # Edge case: was removed — re-add
                    room["players"][rejoin_user_id] = player_data
                
                connections[code][rejoin_user_id] = ws
                user_id = rejoin_user_id
                
                # Clean up disconnected entry
                disconnected_players[code].pop(rejoin_user_id, None)
                if not disconnected_players[code]:
                    disconnected_players.pop(code, None)
                
                await ws.send_json({"event": "rejoined", "data": {
                    "userId": rejoin_user_id,
                    "matchToken": rejoin_token,
                    "isHost": rejoin_user_id == room["host"],
                    "team": player_data.get("team"),
                    "score": player_data["score"],
                    "gameState": room["state"],
                    "language": lang,
                    "roomCode": code
                }})
                
                await broadcast(code, "playerReconnected", {
                    "player": player_data["name"],
                    "message": get_text(lang, "player_reconnected", player=player_data["name"])
                }, exclude=rejoin_user_id)

            elif action == "rematch":
                # Post-game rematch — host resets room, everyone returns to lobby
                room = get_room(code)
                if not room:
                    continue
                
                lang = room.get("language", "en")
                msg_user_id = msg.get("userId")
                token = msg.get("matchToken")
                
                player = room["players"].get(msg_user_id)
                if not player or player["match_token"] != token:
                    await ws.send_json({"event": "error", "data": get_text(lang, "invalid_credentials")})
                    continue
                
                if msg_user_id != room["host"]:
                    await ws.send_json({"event": "error", "data": get_text(lang, "only_host_start")})
                    continue
                
                # Only allow rematch from game over state or waiting
                if room["state"] not in ["waiting", "gameOver"]:
                    # Also allow if game just ended (state might still be "answered")
                    pass
                
                # Reset the room
                if not reset_room_for_rematch(code):
                    await ws.send_json({"event": "error", "data": "Could not reset room"})
                    continue
                
                # Determine can_start
                MAX_PLAYERS = 4
                can_start = False
                if room["game_mode"] == "team":
                    red_count = sum(1 for p in room["players"].values() if p.get("team") == "red")
                    blue_count = sum(1 for p in room["players"].values() if p.get("team") == "blue")
                    can_start = len(room["players"]) == 4 and red_count == 2 and blue_count == 2
                else:
                    can_start = len(room["players"]) >= 2 and len(room["players"]) <= MAX_PLAYERS
                
                # Broadcast rematch to all players
                await broadcast(code, "rematchStarted", {
                    "message": get_text(lang, "rematch_starting"),
                    "roomCode": code,
                    "players": [
                        {
                            "name": p["name"],
                            "score": p["score"],
                            "isHost": uid == room["host"],
                            "team": p.get("team"),
                            "avatar": p.get("avatar")
                        }
                        for uid, p in room["players"].items()
                    ],
                    "count": len(room["players"]),
                    "maxPlayers": MAX_PLAYERS,
                    "canStart": can_start,
                    "gameMode": room["game_mode"],
                    "teamCounts": {
                        "red": sum(1 for p in room["players"].values() if p.get("team") == "red"),
                        "blue": sum(1 for p in room["players"].values() if p.get("team") == "blue")
                    } if room["game_mode"] == "team" else None
                })
                
                # Re-publish to lobby if public
                if room.get("is_public"):
                    await broadcast_public_rooms()

            elif action == "answer":
                room = get_room(code)
                if not room:
                    continue
                
                msg_user_id = msg.get("userId")
                token = msg.get("matchToken")
                idx = msg.get("idx")
                lang = room.get("language", "en")

                if not isinstance(idx, int):
                    continue

                player = room["players"].get(msg_user_id)
                if not player or player["match_token"] != token:
                    continue
                
                if not player.get("active", True):
                    await send_to_user(code, msg_user_id, "error", "You have been eliminated and cannot answer")
                    continue

                async with room_locks[code]:
                    if room["buzzed"] != msg_user_id or room["answered"]:
                        continue

                    room["answered"] = True
                    room["state"] = "answered"
                    q = room["current_q"]

                    if not (0 <= idx < len(q["options"])):
                        continue

                    correct = idx == q["correct"]
                    points_earned = 0
                    score_multiplier = room.get("score_multiplier", 1.0)
                    
                    # Calculate response time for adaptive tracking
                    response_time = time.time() - room.get("question_start_time", time.time())
                    
                    if correct:
                        # Calculate time-based score with adaptive multiplier
                        elapsed = time.time() - room.get("question_start_time", time.time())
                        time_left = max(0, room.get("max_time", 10) - elapsed)
                        base_points = calculate_time_score(time_left, room.get("max_time", 10))
                        points_earned = int(base_points * score_multiplier)
                        player["score"] += points_earned
                        # Add score to team if team mode
                        if room["game_mode"] == "team" and player.get("team"):
                            room["teams"][player["team"]]["score"] += points_earned
                    else:
                        # Penalty for wrong answer - allow negative scores
                        points_earned = -WRONG_ANSWER_PENALTY
                        player["score"] -= WRONG_ANSWER_PENALTY
                        # Deduct from team if team mode - allow negative
                        if room["game_mode"] == "team" and player.get("team"):
                            room["teams"][player["team"]]["score"] -= WRONG_ANSWER_PENALTY
                    
                    # Update adaptive difficulty state
                    # Per-player adaptive state
                    if "adaptive" in player:
                        update_adaptive_state(player["adaptive"], correct, response_time)
                    
                    # Collective room adaptive state (for multiplayer difficulty scaling)
                    active_count = sum(1 for p in room["players"].values() if p.get("active", True))
                    # For collective: count this answer toward the room's performance
                    # (simplified — we update after each answer, not after all players answer)
                    update_room_collective(room, 1 if correct else 0, 1, response_time)

                    correct_answer = q["options"][q["correct"]]
                    message = get_text(lang, "correct") if correct else get_text(lang, "wrong", answer=correct_answer)

                    await broadcast(code, "answerResult", {
                        "correct": correct,
                        "answer": correct_answer,
                        "answeredBy": player["name"],
                        "message": message,
                        "scores": {p["name"]: p["score"] for p in room["players"].values()},
                        "teamScores": room.get("teams") if room["game_mode"] == "team" else None,
                        "selectedIdx": idx,
                        "pointsEarned": points_earned,
                        "difficulty": room.get("adaptive_level", "medium"),
                        "scoreMultiplier": score_multiplier,
                    })

                    await asyncio.sleep(3)
                    await next_question(code)

    except WebSocketDisconnect:
        pass
    finally:
        # Clean up lobby connection
        if user_id and "LOBBY" in connections:
            connections["LOBBY"].pop(user_id, None)
        
        if code in connections and user_id in connections[code]:
            connections[code].pop(user_id, None)
        
        room = get_room(code)
        if room and user_id in room["players"]:
            player_name = room["players"][user_id]["name"]
            was_host = (user_id == room["host"])
            lang = room.get("language", "en")
            game_state = room.get("state", "waiting")
            
            # If game is in progress, stash player for reconnection instead of removing
            if game_state in ["question", "buzzed", "answered"]:
                player_data = room["players"][user_id].copy()
                if code not in disconnected_players:
                    disconnected_players[code] = {}
                disconnected_players[code][user_id] = {
                    "player_data": player_data,
                    "disconnected_at": time.time(),
                    "match_token": player_data["match_token"]
                }
                # Mark as disconnected but don't remove yet
                room["players"][user_id]["connected"] = False
                
                await broadcast(code, "playerDisconnected", {
                    "player": player_name,
                    "message": f"{player_name} disconnected — waiting for reconnection...",
                    "timeout": RECONNECT_WINDOW
                }, exclude=user_id)
                
                # Schedule cleanup after RECONNECT_WINDOW
                asyncio.create_task(_delayed_disconnect_cleanup(code, user_id, player_name, was_host))
            else:
                # Not in game — remove immediately (lobby/waiting/gameOver)
                room["players"].pop(user_id)
                
                if was_host and room["players"]:
                    new_host = next(iter(room["players"].keys()))
                    room["host"] = new_host
                    await broadcast(code, "newHost", {
                        "hostName": room["players"][new_host]["name"],
                        "message": get_text(lang, "new_host", host=room["players"][new_host]["name"])
                    })
                
                MAX_PLAYERS = 4
                can_start = False
                if room["game_mode"] == "team":
                    red_count = sum(1 for p in room["players"].values() if p.get("team") == "red")
                    blue_count = sum(1 for p in room["players"].values() if p.get("team") == "blue")
                    can_start = len(room["players"]) == 4 and red_count == 2 and blue_count == 2
                else:
                    can_start = len(room["players"]) >= 2 and len(room["players"]) <= MAX_PLAYERS
                
                await broadcast(code, "playerLeft", {
                    "player": player_name,
                    "remaining": len(room["players"]),
                    "message": get_text(lang, "player_left", player=player_name)
                })
                
                await broadcast(code, "players", {
                    "players": [
                        {
                            "name": p["name"], 
                            "score": p["score"],
                            "isHost": uid == room["host"],
                            "team": p.get("team"),
                            "avatar": p.get("avatar")
                        }
                        for uid, p in room["players"].items()
                    ],
                    "count": len(room["players"]),
                    "maxPlayers": MAX_PLAYERS,
                    "canStart": can_start,
                    "gameMode": room["game_mode"],
                    "teamCounts": {
                        "red": sum(1 for p in room["players"].values() if p.get("team") == "red"),
                        "blue": sum(1 for p in room["players"].values() if p.get("team") == "blue")
                    } if room["game_mode"] == "team" else None
                })
                
                if room.get("is_public"):
                    await broadcast_public_rooms()
                
                if len(room["players"]) == 0:
                    await cleanup_room(code)


async def _delayed_disconnect_cleanup(code: str, user_id: str, player_name: str, was_host: bool):
    """After RECONNECT_WINDOW seconds, if the player hasn't reconnected, remove them for real"""
    await asyncio.sleep(RECONNECT_WINDOW)
    
    room = get_room(code)
    if not room:
        return
    
    # Check if player already reconnected (connected flag restored)
    player = room["players"].get(user_id)
    if not player:
        return  # Already removed
    if player.get("connected", True):
        return  # Reconnected successfully
    
    # Player didn't reconnect — remove them now
    lang = room.get("language", "en")
    game_state = room.get("state", "waiting")
    room["players"].pop(user_id, None)
    
    # Clean up disconnected_players entry
    if code in disconnected_players:
        disconnected_players[code].pop(user_id, None)
    
    if was_host and room["players"]:
        new_host = next(iter(room["players"].keys()))
        room["host"] = new_host
        await broadcast(code, "newHost", {
            "hostName": room["players"][new_host]["name"],
            "message": get_text(lang, "new_host", host=room["players"][new_host]["name"])
        })
    
    await broadcast(code, "playerLeft", {
        "player": player_name,
        "remaining": len(room["players"]),
        "message": get_text(lang, "player_left", player=player_name)
    })
    
    # End game if not enough players remain
    if game_state in ["question", "buzzed", "answered"]:
        connected_players = {uid: p for uid, p in room["players"].items() if p.get("connected", True)}
        min_players = 4 if room.get("game_mode") == "team" else 2
        if len(connected_players) < min_players:
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "not_enough_players"),
                "winner": None,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
                "teamScores": room.get("teams") if room.get("game_mode") == "team" else None
            })
            await cleanup_room(code)
    elif len(room["players"]) == 0:
        await cleanup_room(code)

# === GAME LOGIC ===

 #KANE
async def start_question(code: str):
    room = get_room(code)
    if not room:
        return
    
    lang = room.get("language", "en")
    subjects = room.get("subjects", [])
    ai_questions = room.get("ai_questions", None)
    quiz_type = room.get("quiz_type", "classic")
    
    # For picguess mode, ensure picguess questions are included
    if quiz_type == "picguess" and "picguess" not in subjects:
        subjects = subjects + ["picguess"]
    
    # Debug logging
    print(f"start_question called for room {code}")
    print(f"AI questions in room: {ai_questions is not None}")
    if ai_questions:
        print(f"Number of AI questions: {len(ai_questions)}")
    print(f"Available questions: {len(room['available'])}")

    if not room["available"]:
        # Check if we have AI-generated questions
        if ai_questions and len(ai_questions) > 0:
            room["available"] = ai_questions.copy()
            random.shuffle(room["available"])
        else:
            # Use predefined questions from questions.json
            questions = []
            for subject in subjects:
                if subject in ALL_QUESTIONS.get(lang, {}):
                    questions.extend(ALL_QUESTIONS[lang][subject])
            
            if not questions:
                for subject in ALL_QUESTIONS.get(lang, {}).keys():
                    questions.extend(ALL_QUESTIONS[lang][subject])
            
            room["available"] = questions.copy()
            random.shuffle(room["available"])

    if not room["available"]:
        if room["game_mode"] == "team":
            active_teams = {name: team for name, team in room["teams"].items() if team.get("active", True)}
            winner_team = max(active_teams.keys(), key=lambda t: active_teams[t]["score"]) if active_teams else None
            team_name = get_text(lang, f"team_{winner_team}") if winner_team else None
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "winner": team_name,
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()},
                "teamScores": room["teams"]
            })
        else:
            await broadcast(code, "gameOver", {
                "reason": get_text(lang, "all_questions_completed"),
                "finalScores": {p["name"]: p["score"] for p in room["players"].values()}
            })
        await end_game(code)
        return

    q = None
    quiz_type = room.get("quiz_type", "classic")
    
    # Adaptive difficulty — select question by difficulty level
    room_adaptive = get_room_collective_state(room)
    modifiers = get_adaptive_modifiers(room_adaptive)
    target_diff = modifiers["target_difficulty"]
    
    if len(room["available"]) > 1:
        # Try to pick a question matching the target difficulty
        q = select_question_by_difficulty(room["available"], target_diff)
        if q:
            room["available"].remove(q)
        else:
            q = room["available"].pop()
    else:
        q = room["available"].pop()
    
    room["current_q"] = q
    
    # Adjust timer based on quiz type AND adaptive difficulty
    base_time = q.get("time", 10)
    if quiz_type == "speed":
        base_time = max(5, base_time // 2)
    elif quiz_type == "picguess":
        base_time = 15
    
    # Apply adaptive timer modifier
    adaptive_timer = max(5, base_time + modifiers["timer_bonus"])
    room["timer"] = adaptive_timer
    room["score_multiplier"] = modifiers["score_multiplier"]
    room["adaptive_level"] = room_adaptive["level"]
    
    room["max_time"] = room["timer"]
    room["question_start_time"] = time.time()
    room["buzzed"] = None
    room["answered"] = False
    room["state"] = "question"
    room["questions_in_round"] += 1

    # Build question data based on quiz type
    question_data = {
        "q": q["q"],
        "time": room["timer"],
        "remaining": len(room["available"]),
        "round": room["current_round"],
        "questionInRound": room["questions_in_round"],
        "questionsPerRound": room["questions_per_round"],
        "quizType": quiz_type,
        "difficulty": room.get("adaptive_level", "medium"),
        "scoreMultiplier": room.get("score_multiplier", 1.0),
    }
    
    if quiz_type == "truefalse":
        # Convert to True/False: show the question, correct answer is at q["correct"]
        correct_option = q["options"][q["correct"]]
        # 50% chance to show the correct answer as the statement, 50% a wrong one
        if random.random() > 0.5:
            question_data["q"] = f"{q['q']} → {correct_option}"
            question_data["options"] = ["Vrai", "Faux"]
            question_data["tfCorrect"] = 0  # "Vrai" is correct
        else:
            wrong_options = [o for i, o in enumerate(q["options"]) if i != q["correct"]]
            wrong_answer = random.choice(wrong_options) if wrong_options else correct_option
            question_data["q"] = f"{q['q']} → {wrong_answer}"
            question_data["options"] = ["Vrai", "Faux"]
            question_data["tfCorrect"] = 1  # "Faux" is correct
        # Override correct index for answer checking
        room["current_q"] = {**q, "options": ["Vrai", "Faux"], "correct": question_data["tfCorrect"]}
    elif quiz_type == "picguess":
        # Picture guess: send image with blur level metadata
        question_data["options"] = q["options"]
        question_data["picguess"] = True
        question_data["blurStart"] = 20  # Start blur in px
        question_data["blurEnd"] = 0  # End blur
        if "image" in q:
            question_data["image"] = q["image"]
    else:
        # Classic and speed use normal options
        question_data["options"] = q["options"]
    
    # Include image if present (for flag quiz etc.)
    if "image" in q and "image" not in question_data:
        question_data["image"] = q["image"]
    
    await broadcast(code, "question", question_data)
    
    asyncio.create_task(timer_task(code))
#KANE
async def next_question(code: str):
    room = get_room(code)
    if not room:
        return
    
    lang = room.get("language", "en")
    
    # Check if round is complete
    if room["questions_in_round"] >= room["questions_per_round"]:
        # Round complete - show round summary
        await broadcast(code, "roundComplete", {
            "round": room["current_round"],
            "maxRounds": room["max_rounds"],
            "message": get_text(lang, "round_complete", round=room["current_round"]),
            "scores": {p["name"]: p["score"] for p in room["players"].values()},
            "activePlayers": [p["name"] for uid, p in room["players"].items() if p.get("active", True)],
            "teamScores": room.get("teams") if room["game_mode"] == "team" else None
        })
        
        await asyncio.sleep(3)
        
        # Eliminate lowest player/team (if not final round)
        if room["current_round"] < room["max_rounds"]:
            if room["game_mode"] == "team":
                game_ended = await eliminate_lowest_team(code)
            else:
                game_ended = await eliminate_lowest_player(code)
            
            if game_ended:
                return
            await asyncio.sleep(3)
        
        # Start next round
        await start_next_round(code)
    else:
        # Continue with next question
        await start_question(code)


# === AI QUESTION GENERATION ===

# Minimum questions needed before we stop generating new ones
MIN_CACHE_SIZE = 90

async def generate_ai_questions(category: str, num_questions: int = 10, language: str = "fr") -> List[Dict]:
    """Generate trivia questions using Hugging Face API with smart caching"""
    
    cache_key = f"{category.lower().strip()}_{language}"
    
    # Check how many questions we have cached
    cached_count = len(ai_questions_cache.get(cache_key, []))
    
    # HYBRID LOGIC:
    # If we have enough cached questions (>= MIN_CACHE_SIZE), just return random selection
    # If we have some but not enough, generate more and add to pool
    # If we have none, generate fresh
    
    if cached_count >= MIN_CACHE_SIZE:
        # We have enough! Return random selection instantly
        print(f"Cache hit for '{category}': {cached_count} questions available")
        return random.sample(ai_questions_cache[cache_key], num_questions)
    
    # We need more questions - generate new ones
    print(f"Generating more questions for '{category}' (current cache: {cached_count})")
    
    # Generate more questions to build up the pool
    questions_to_generate = 15  # Generate 15 at a time to build cache faster
    
    lang_instruction = "en français" if language == "fr" else "in English"
    
    system_prompt = f"""Tu es un générateur de questions de quiz. Tu dois générer exactement {questions_to_generate} questions de trivia.

IMPORTANT: Réponds UNIQUEMENT avec un tableau JSON valide, sans aucun texte avant ou après.

Format EXACT requis:
[
  {{
    "question": "La question ici?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "answer": "La bonne réponse (doit être identique à une des options)"
  }}
]

Règles:
- Chaque question doit avoir exactement 4 options
- La réponse doit être exactement une des 4 options
- Les questions doivent être variées et intéressantes
- Assure-toi que les faits sont corrects
- NE PAS répéter de questions similaires"""

    user_prompt = f"Génère {questions_to_generate} questions de trivia sur le thème: \"{category}\" {lang_instruction}. Réponds uniquement avec le JSON."

    headers = {
        "Authorization": f"Bearer {HF_API_TOKEN}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": HF_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "max_tokens": 2500,
        "temperature": 0.8
    }
    
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            print(f"Calling HF API for category: {category}")
            response = await client.post(HF_API_URL, headers=headers, json=payload)
            
            print(f"HF API response status: {response.status_code}")
            
            if response.status_code == 503 or response.status_code == 500:
                # Model is loading - if we have some cached, use those
                print(f"Model loading (503/500), cached_count: {cached_count}")
                if cached_count >= num_questions:
                    print(f"Using {cached_count} cached questions")
                    return random.sample(ai_questions_cache[cache_key], num_questions)
                return None
            
            if response.status_code != 200:
                print(f"HF API error: {response.status_code} - {response.text}")
                # Fallback to cache if available
                if cached_count >= num_questions:
                    return random.sample(ai_questions_cache[cache_key], num_questions)
                return None
            
            result = response.json()
            print(f"HF API result: {result}")
            
            # Parse chat completions response format
            generated_text = ""
            if isinstance(result, dict):
                # New chat completions format
                if "choices" in result and len(result["choices"]) > 0:
                    generated_text = result["choices"][0].get("message", {}).get("content", "")
                # Old format fallback
                elif "generated_text" in result:
                    generated_text = result["generated_text"]
            elif isinstance(result, list) and len(result) > 0:
                generated_text = result[0].get("generated_text", "")
            
            if not generated_text:
                generated_text = str(result)
            
            print(f"Generated text length: {len(generated_text)}")
            print(f"Generated text preview: {generated_text[:500]}...")
            
            # Parse JSON from response
            new_questions = parse_ai_response(generated_text)
            
            if new_questions:
                # Initialize cache for this category if needed
                if cache_key not in ai_questions_cache:
                    ai_questions_cache[cache_key] = []
                
                # Add new questions, avoiding duplicates
                existing_questions = {q["question"] for q in ai_questions_cache[cache_key]}
                unique_new = [q for q in new_questions if q["question"] not in existing_questions]
                
                ai_questions_cache[cache_key].extend(unique_new)
                
                total_cached = len(ai_questions_cache[cache_key])
                print(f"Added {len(unique_new)} new questions. Total cached for '{category}': {total_cached}")
                
                # Save cache to file for persistence
                save_cache_to_file()
                
                # Return random selection from the full pool
                return random.sample(ai_questions_cache[cache_key], min(num_questions, total_cached))
            
            # If parsing failed but we have cache, use it
            if cached_count >= num_questions:
                return random.sample(ai_questions_cache[cache_key], num_questions)
            
            return None
            
    except Exception as e:
        print(f"Error generating questions: {e}")
        # Fallback to cache if available
        if cached_count >= num_questions:
            return random.sample(ai_questions_cache[cache_key], num_questions)
        return None


def get_cache_stats() -> Dict[str, Any]:
    """Get statistics about the question cache"""
    stats = {}
    for key, questions in ai_questions_cache.items():
        stats[key] = {
            "count": len(questions),
            "ready": len(questions) >= MIN_CACHE_SIZE
        }
    return stats


def parse_ai_response(text: str) -> List[Dict]:
    """Parse AI response to extract questions JSON"""
    try:
        # Try to find JSON array in the response
        # Look for [ ... ] pattern
        json_match = re.search(r'\[[\s\S]*\]', text)
        if json_match:
            json_str = json_match.group()
            questions = json.loads(json_str)
            
            # Validate questions format
            valid_questions = []
            for q in questions:
                if (isinstance(q, dict) and 
                    "question" in q and 
                    "options" in q and 
                    "answer" in q and
                    isinstance(q["options"], list) and 
                    len(q["options"]) == 4 and
                    q["answer"] in q["options"]):
                    valid_questions.append({
                        "question": q["question"],
                        "options": q["options"],
                        "answer": q["answer"]
                    })
            
            return valid_questions if valid_questions else None
        
        return None
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")
        return None
    except Exception as e:
        print(f"Parse error: {e}")
        return None


@app.post("/api/generate-questions")
async def api_generate_questions(request: Request):
    """API endpoint to generate custom category questions"""
    try:
        data = await request.json()
        category = data.get("category", "").strip()
        num_questions = min(data.get("count", 10), 20)  # Max 20 questions
        language = data.get("language", "fr")
        
        if not category:
            return JSONResponse(
                status_code=400,
                content={"error": "Category is required"}
            )
        
        if len(category) > 100:
            return JSONResponse(
                status_code=400,
                content={"error": "Category too long (max 100 characters)"}
            )
        
        questions = await generate_ai_questions(category, num_questions, language)
        
        if questions:
            return JSONResponse(content={
                "success": True,
                "questions": questions,
                "category": category,
                "count": len(questions)
            })
        else:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "Could not generate questions. The AI model might be loading. Please try again in a few seconds.",
                    "retry": True
                }
            )
            
    except Exception as e:
        print(f"API error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": "Internal server error"}
        )


@app.get("/api/check-model")
async def check_model_status():
    """Check if the HF model is ready"""
    headers = {"Authorization": f"Bearer {HF_API_TOKEN}"}
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                HF_API_URL, 
                headers=headers, 
                json={"inputs": "test", "parameters": {"max_new_tokens": 1}}
            )
            
            if response.status_code == 503:
                return JSONResponse(content={"ready": False, "message": "Model is loading..."})
            elif response.status_code == 200:
                return JSONResponse(content={"ready": True, "message": "Model is ready"})
            else:
                return JSONResponse(content={"ready": False, "message": f"Error: {response.status_code}"})
    except Exception as e:
        return JSONResponse(content={"ready": False, "message": str(e)})


@app.get("/api/cache-stats")
async def cache_stats():
    """Get AI question cache statistics"""
    stats = get_cache_stats()
    total_questions = sum(len(q) for q in ai_questions_cache.values())
    total_categories = len(ai_questions_cache)
    
    return JSONResponse(content={
        "total_questions": total_questions,
        "total_categories": total_categories,
        "min_cache_size": MIN_CACHE_SIZE,
        "categories": stats
    })


app.mount("/static", StaticFiles(directory="static"), name="static")
