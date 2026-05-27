"""
OpenDoc — SQLite Database Service Layer

Manages connection to local database and provides functions to save/load session states and evolution notes.
"""

import sqlite3
import os
import json
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Locate database in the backend directory
DATABASE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "opendoc.db")

def get_connection():
    """Establish connection with SQLite and configure Row factory."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def infer_primary_language(files: list) -> str:
    """Infer the primary language of the session from file extensions."""
    ext_counts = {}
    for f in files:
        filename = f.get("filename", "")
        _, ext = os.path.splitext(filename.lower())
        if ext:
            ext_counts[ext] = ext_counts.get(ext, 0) + 1
    if not ext_counts:
        return "Unknown"
    
    # Find most common extension
    main_ext = max(ext_counts, key=ext_counts.get)
    # Map extension to language name
    mapping = {
        ".py": "Python",
        ".js": "JavaScript",
        ".ts": "TypeScript",
        ".tsx": "TypeScript",
        ".jsx": "JavaScript",
        ".go": "Go",
        ".rs": "Rust",
        ".cs": "C#",
        ".java": "Java",
        ".rb": "Ruby",
        ".php": "PHP",
        ".cpp": "C++",
        ".h": "C/C++",
        ".c": "C",
        ".html": "HTML",
        ".css": "CSS",
    }
    return mapping.get(main_ext, main_ext.lstrip('.').upper())

def calculate_session_duration(conn, session_id: str, current_ts_str: str) -> float:
    """Calculate session duration in seconds since the first recorded state."""
    try:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT timestamp FROM session_states WHERE session_id = ? ORDER BY timestamp ASC LIMIT 1",
            (session_id,)
        )
        row = cursor.fetchone()
        if not row:
            return 0.0
        
        # Parse ISO timestamps
        def parse_ts(ts_str):
            clean_ts = ts_str.replace("Z", "+00:00")
            return datetime.fromisoformat(clean_ts)
        
        first_dt = parse_ts(row["timestamp"])
        curr_dt = parse_ts(current_ts_str)
        
        duration = (curr_dt - first_dt).total_seconds()
        return max(0.0, duration)
    except Exception as e:
        logger.warning(f"Error calculating session duration: {e}")
        return 0.0

def init_db():
    """Create session_states and evolution_notes tables, and run migrations if necessary."""
    logger.info(f"Initializing SQLite database at: {DATABASE_PATH}")
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        # 1. Create new table for storing session states (replaces snapshots)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS session_states (
                session_id TEXT,
                timestamp TEXT,
                goal TEXT,
                files TEXT,
                files_changed_count INTEGER,
                session_duration REAL,
                major_focus TEXT,
                detected_patterns TEXT,
                primary_language TEXT,
                PRIMARY KEY (session_id, timestamp)
            )
        """)
        
        # 2. Create new table for storing evolution notes (replaces note_versions)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS evolution_notes (
                session_id TEXT,
                timestamp TEXT,
                goal TEXT,
                intent_summary TEXT,
                architecture_evolution TEXT,
                development_progression TEXT,
                files_changed_count INTEGER,
                session_duration REAL,
                major_focus TEXT,
                detected_patterns TEXT,
                primary_language TEXT,
                PRIMARY KEY (session_id, timestamp)
            )
        """)
        
        conn.commit()
        
        # 3. Check for migration from deprecated 'snapshots' and 'note_versions' tables
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'")
        has_snapshots = cursor.fetchone() is not None
        
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='note_versions'")
        has_note_versions = cursor.fetchone() is not None
        
        # Migrate snapshots -> session_states
        if has_snapshots:
            cursor.execute("SELECT COUNT(*) as count FROM session_states")
            states_count = cursor.fetchone()["count"]
            if states_count == 0:
                logger.info("Migrating legacy 'snapshots' table to 'session_states'...")
                cursor.execute("SELECT * FROM snapshots")
                snapshots = cursor.fetchall()
                for snap in snapshots:
                    files_str = snap["files"]
                    try:
                        files_list = json.loads(files_str)
                    except Exception:
                        files_list = []
                    
                    lang = infer_primary_language(files_list)
                    cursor.execute("""
                        INSERT OR IGNORE INTO session_states 
                        (session_id, timestamp, goal, files, files_changed_count, session_duration, major_focus, detected_patterns, primary_language) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        snap["session_id"],
                        snap["timestamp"],
                        snap["goal"],
                        files_str,
                        len(files_list),
                        0.0,  # default duration
                        "",
                        "[]",
                        lang
                    ))
                conn.commit()
                logger.info("Snapshot migration completed.")
        
        # Migrate note_versions -> evolution_notes
        if has_note_versions:
            cursor.execute("SELECT COUNT(*) as count FROM evolution_notes")
            notes_count = cursor.fetchone()["count"]
            if notes_count == 0:
                logger.info("Migrating legacy 'note_versions' table to 'evolution_notes'...")
                cursor.execute("SELECT * FROM note_versions")
                note_versions = cursor.fetchall()
                for nv in note_versions:
                    cursor.execute("""
                        INSERT OR IGNORE INTO evolution_notes 
                        (session_id, timestamp, goal, intent_summary, architecture_evolution, development_progression, files_changed_count, session_duration, major_focus, detected_patterns, primary_language) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        nv["session_id"],
                        nv["timestamp"],
                        nv["goal"],
                        nv["summary"],  # legacy summary maps to intent_summary
                        "",  # empty architecture evolution
                        "",  # empty development progression
                        0,
                        0.0,
                        "",
                        "[]",
                        ""
                    ))
                conn.commit()
                logger.info("Note version migration completed.")
                
        conn.close()
        logger.info("Database tables initialized and migrated successfully.")
    except Exception as e:
        logger.exception("Failed to initialize database.")
        raise e

def save_session_state(session_id: str, timestamp: str, goal: str, files: list) -> dict:
    """Save a session state to the session_states table."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        # Automatically calculate metadata
        duration = calculate_session_duration(conn, session_id, timestamp)
        lang = infer_primary_language(files)
        files_count = len(files)
        
        # Check if there is already a major focus or patterns stored for this, or set empty defaults
        cursor.execute(
            "SELECT major_focus, detected_patterns FROM session_states WHERE session_id = ? AND timestamp = ?",
            (session_id, timestamp)
        )
        existing = cursor.fetchone()
        major_focus = existing["major_focus"] if existing else ""
        detected_patterns = existing["detected_patterns"] if existing else "[]"
        
        cursor.execute("""
            INSERT OR REPLACE INTO session_states 
            (session_id, timestamp, goal, files, files_changed_count, session_duration, major_focus, detected_patterns, primary_language) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id,
            timestamp,
            goal,
            json.dumps(files),
            files_count,
            duration,
            major_focus,
            detected_patterns,
            lang
        ))
        conn.commit()
        conn.close()
        logger.debug(f"Saved session state for session {session_id} at {timestamp}.")
        
        return {
            "session_id": session_id,
            "timestamp": timestamp,
            "goal": goal,
            "files": files,
            "files_changed_count": files_count,
            "session_duration": duration,
            "major_focus": major_focus,
            "detected_patterns": json.loads(detected_patterns),
            "primary_language": lang
        }
    except Exception as e:
        logger.error(f"Error saving session state: {e}")
        raise e

def get_previous_session_state(session_id: str, timestamp: str) -> Optional[dict]:
    """Retrieve the latest session state before the given timestamp."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM session_states WHERE session_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1",
            (session_id, timestamp)
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            return {
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
                "goal": row["goal"],
                "files": json.loads(row["files"]),
                "files_changed_count": row["files_changed_count"],
                "session_duration": row["session_duration"],
                "major_focus": row["major_focus"],
                "detected_patterns": json.loads(row["detected_patterns"]) if row["detected_patterns"] else [],
                "primary_language": row["primary_language"]
            }
        return None
    except Exception as e:
        logger.error(f"Error fetching previous session state: {e}")
        return None

def save_evolution_note(
    session_id: str,
    timestamp: str,
    goal: str,
    intent_summary: str,
    architecture_evolution: str,
    development_progression: str,
    files_changed_count: int,
    session_duration: float,
    major_focus: str,
    detected_patterns: list,
    primary_language: str
) -> None:
    """Save a generated evolution note to the evolution_notes table."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        # Save evolution note
        cursor.execute("""
            INSERT OR REPLACE INTO evolution_notes 
            (session_id, timestamp, goal, intent_summary, architecture_evolution, development_progression, files_changed_count, session_duration, major_focus, detected_patterns, primary_language) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id,
            timestamp,
            goal,
            intent_summary,
            architecture_evolution,
            development_progression,
            files_changed_count,
            session_duration,
            major_focus,
            json.dumps(detected_patterns),
            primary_language
        ))
        
        # Also update the corresponding session state table with the AI-inferred major_focus and patterns
        cursor.execute("""
            UPDATE session_states 
            SET major_focus = ?, detected_patterns = ? 
            WHERE session_id = ? AND timestamp = ?
        """, (
            major_focus,
            json.dumps(detected_patterns),
            session_id,
            timestamp
        ))
        
        conn.commit()
        conn.close()
        logger.debug(f"Saved evolution note for session {session_id} at {timestamp}.")
    except Exception as e:
        logger.error(f"Error saving evolution note: {e}")
        raise e

def get_evolution_notes(session_id: str) -> list[dict]:
    """Retrieve all saved evolution notes for a session sorted descending by timestamp."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM evolution_notes WHERE session_id = ? ORDER BY timestamp DESC",
            (session_id,)
        )
        rows = cursor.fetchall()
        conn.close()
        return [
            {
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
                "goal": row["goal"],
                "intent_summary": row["intent_summary"],
                "architecture_evolution": row["architecture_evolution"],
                "development_progression": row["development_progression"],
                "files_changed_count": row["files_changed_count"],
                "session_duration": row["session_duration"],
                "major_focus": row["major_focus"],
                "detected_patterns": json.loads(row["detected_patterns"]) if row["detected_patterns"] else [],
                "primary_language": row["primary_language"]
            }
            for row in rows
        ]
    except Exception as e:
        logger.error(f"Error fetching evolution notes: {e}")
        return []
