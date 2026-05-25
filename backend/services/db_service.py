"""
OpenDoc — SQLite Database Service Layer

Manages connection to local database and provides functions to save/load snapshots and note versions.
"""

import sqlite3
import os
import json
import logging

logger = logging.getLogger(__name__)

# Locate database in the backend directory
DATABASE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "opendoc.db")

def get_connection():
    """Establish connection with SQLite and configure Row factory."""
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Create snapshots and note_versions tables if they do not exist."""
    logger.info(f"Initializing SQLite database at: {DATABASE_PATH}")
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        # Table for storing snapshots (commits)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                session_id TEXT,
                timestamp TEXT,
                goal TEXT,
                files TEXT,
                PRIMARY KEY (session_id, timestamp)
            )
        """)
        
        # Table for storing AI generated notes diffs
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS note_versions (
                session_id TEXT,
                timestamp TEXT,
                summary TEXT,
                goal TEXT,
                PRIMARY KEY (session_id, timestamp)
            )
        """)
        
        conn.commit()
        conn.close()
        logger.info("Database tables initialized successfully.")
    except Exception as e:
        logger.exception("Failed to initialize database.")
        raise e

def save_snapshot(session_id: str, timestamp: str, goal: str, files: list) -> None:
    """Save a snapshot (commit) to the snapshots table."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO snapshots (session_id, timestamp, goal, files) VALUES (?, ?, ?, ?)",
            (session_id, timestamp, goal, json.dumps(files))
        )
        conn.commit()
        conn.close()
        logger.debug(f"Saved snapshot for session {session_id} at {timestamp}.")
    except Exception as e:
        logger.error(f"Error saving snapshot: {e}")
        raise e

def get_previous_snapshot(session_id: str, timestamp: str) -> dict:
    """Retrieve the latest snapshot before the given timestamp."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM snapshots WHERE session_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1",
            (session_id, timestamp)
        )
        row = cursor.fetchone()
        conn.close()
        if row:
            return {
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
                "goal": row["goal"],
                "files": json.loads(row["files"])
            }
        return None
    except Exception as e:
        logger.error(f"Error fetching previous snapshot: {e}")
        return None

def save_note_version(session_id: str, timestamp: str, summary: str, goal: str) -> None:
    """Save a generated note version to the note_versions table."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT OR REPLACE INTO note_versions (session_id, timestamp, summary, goal) VALUES (?, ?, ?, ?)",
            (session_id, timestamp, summary, goal)
        )
        conn.commit()
        conn.close()
        logger.debug(f"Saved note version for session {session_id} at {timestamp}.")
    except Exception as e:
        logger.error(f"Error saving note version: {e}")
        raise e

def get_note_versions(session_id: str) -> list[dict]:
    """Retrieve all saved note versions for a session sorted descending by timestamp."""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM note_versions WHERE session_id = ? ORDER BY timestamp DESC",
            (session_id,)
        )
        rows = cursor.fetchall()
        conn.close()
        return [
            {
                "session_id": row["session_id"],
                "timestamp": row["timestamp"],
                "summary": row["summary"],
                "goal": row["goal"]
            }
            for row in rows
        ]
    except Exception as e:
        logger.error(f"Error fetching note versions: {e}")
        return []
