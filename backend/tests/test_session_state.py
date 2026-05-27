import pytest
import os
import sqlite3
import json
from services import db_service

@pytest.fixture
def temp_db(monkeypatch, tmp_path):
    """Fixture to mock DATABASE_PATH to a temporary file."""
    db_file = tmp_path / "test_opendoc.db"
    monkeypatch.setattr(db_service, "DATABASE_PATH", str(db_file))
    
    # Clean up if exists
    if db_file.exists():
        os.remove(db_file)
        
    yield str(db_file)
    
    if db_file.exists():
        try:
            os.remove(db_file)
        except OSError:
            pass

def test_init_db_and_migration(temp_db):
    """Test that init_db correctly initializes new tables and migrates legacy tables if they exist."""
    # 1. Manually create legacy tables and seed data
    conn = sqlite3.connect(temp_db)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE snapshots (
            session_id TEXT,
            timestamp TEXT,
            goal TEXT,
            files TEXT,
            PRIMARY KEY (session_id, timestamp)
        )
    """)
    cursor.execute("""
        CREATE TABLE note_versions (
            session_id TEXT,
            timestamp TEXT,
            summary TEXT,
            goal TEXT,
            PRIMARY KEY (session_id, timestamp)
        )
    """)
    
    # Seed legacy snapshot
    cursor.execute(
        "INSERT INTO snapshots VALUES (?, ?, ?, ?)",
        ("session-123", "2026-05-27T12:00:00Z", "implement login", json.dumps([{"filename": "main.py"}]))
    )
    # Seed legacy note
    cursor.execute(
        "INSERT INTO note_versions VALUES (?, ?, ?, ?)",
        ("session-123", "2026-05-27T12:05:00Z", "added auth routes", "implement login")
    )
    conn.commit()
    conn.close()
    
    # 2. Run init_db which should perform migrations
    db_service.init_db()
    
    # 3. Verify new tables are created and populated
    conn = db_service.get_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM session_states WHERE session_id = ?", ("session-123",))
    state = cursor.fetchone()
    assert state is not None
    assert state["goal"] == "implement login"
    assert state["primary_language"] == "Python"
    assert state["files_changed_count"] == 1
    
    cursor.execute("SELECT * FROM evolution_notes WHERE session_id = ?", ("session-123",))
    note = cursor.fetchone()
    assert note is not None
    assert note["intent_summary"] == "added auth routes"
    assert note["goal"] == "implement login"
    
    conn.close()

def test_save_session_state_metadata(temp_db):
    """Test that save_session_state automatically computes correct metadata."""
    db_service.init_db()
    
    # Save first session state
    db_service.save_session_state(
        session_id="session-456",
        timestamp="2026-05-27T12:00:00Z",
        goal="start backend",
        files=[{"filename": "main.ts"}, {"filename": "utils.ts"}]
    )
    
    # Verify metadata on first save
    conn = db_service.get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM session_states WHERE session_id = 'session-456'")
    row = cursor.fetchone()
    assert row is not None
    assert row["files_changed_count"] == 2
    assert row["session_duration"] == 0.0
    assert row["primary_language"] == "TypeScript"
    conn.close()
    
    # Save second session state 15 minutes later
    db_service.save_session_state(
        session_id="session-456",
        timestamp="2026-05-27T12:15:00Z",
        goal="add functions",
        files=[{"filename": "main.ts"}]
    )
    
    # Verify duration calculation (15 mins = 900 seconds)
    conn = db_service.get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM session_states WHERE session_id = 'session-456' ORDER BY timestamp DESC LIMIT 1")
    row = cursor.fetchone()
    assert row is not None
    assert row["files_changed_count"] == 1
    assert row["session_duration"] == 900.0
    conn.close()

def test_save_and_get_evolution_notes(temp_db):
    """Test saving and loading evolution notes and checking that they update session_states."""
    db_service.init_db()
    
    # Save state first
    db_service.save_session_state(
        session_id="session-789",
        timestamp="2026-05-27T12:00:00Z",
        goal="setup database",
        files=[{"filename": "db.py"}]
    )
    
    # Save evolution note
    db_service.save_evolution_note(
        session_id="session-789",
        timestamp="2026-05-27T12:00:00Z",
        goal="setup database",
        intent_summary="Created DB connection logic",
        architecture_evolution="Added persistence layer",
        development_progression="Initialized SQLite connection and schemas",
        files_changed_count=1,
        session_duration=0.0,
        major_focus="database",
        detected_patterns=["ORM", "persistence"],
        primary_language="Python"
    )
    
    # Fetch notes
    notes = db_service.get_evolution_notes("session-789")
    assert len(notes) == 1
    assert notes[0]["intent_summary"] == "Created DB connection logic"
    assert notes[0]["major_focus"] == "database"
    assert "ORM" in notes[0]["detected_patterns"]
    
    # Check that session_states was updated with major_focus and detected_patterns
    conn = db_service.get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT major_focus, detected_patterns FROM session_states WHERE session_id = 'session-789'")
    row = cursor.fetchone()
    assert row is not None
    assert row["major_focus"] == "database"
    assert "ORM" in json.loads(row["detected_patterns"])
    conn.close()
