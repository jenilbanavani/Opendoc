"""
Tests for PDF Generation and edge case safety.
"""

import pytest
from fastapi.testclient import TestClient
from main import app
from models.schemas import ReportData, ProductDirection
from services.pdf_service import generate_pdf_bytes

client = TestClient(app)

def test_generate_pdf_success():
    report = ReportData(
        repo_name="test-repo",
        repo_url="https://github.com/test/repo",
        executive_summary="This is a test executive summary.",
        what_it_actually_is="A test project.",
        core_strengths=["Strength 1", "Strength 2"],
        engineering_assessment="Good engineering patterns.",
        scope_vs_execution="On track.",
        product_direction=ProductDirection(
            strongest_direction="Go to market",
            highest_impact_next_step="Build UI",
            biggest_technical_risk="Scaling",
            most_impressive_aspect="Performance",
            most_underrated_feature="CLI"
        ),
        biggest_risks=["Risk 1"],
        most_impressive_aspect="Wow",
        recommended_next_step="Step 1",
        portfolio_assessment="Great portfolio piece",
        developer_intelligence="Smart developer",
        final_verdict="Highly recommended"
    )
    pdf_bytes = generate_pdf_bytes(report)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0

def test_generate_pdf_unicode_characters():
    # Test emojis, smart quotes, backticks, math symbols
    report = ReportData(
        repo_name="test-repo-🚀",
        repo_url="https://github.com/test/repo-🚀",
        executive_summary="Testing smart quotes: “Hello” and ‘World’ — also emojis: 🔥 💻.",
        what_it_actually_is="Testing math: α + β = γ. Backticks: `code`.",
        core_strengths=["Unicode item: 🛠️"],
        engineering_assessment="Patterns: 中文 test.",
        final_verdict="Verdict with non-latin-1 chars: 🌟"
    )
    pdf_bytes = generate_pdf_bytes(report)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0

def test_generate_pdf_null_and_missing_values():
    # Instantiate standard report, then bypass constructor validation to set fields to None or lists with None
    report = ReportData(
        repo_name="test-repo",
    )
    
    # Set fields directly to bypass Pydantic init validation
    report.executive_summary = None  # type: ignore
    report.what_it_actually_is = None  # type: ignore
    report.product_direction = None
    report.core_strengths = ["Valid strength", None, "Another strength"]  # type: ignore
    report.biggest_risks = [None]  # type: ignore
    
    pdf_bytes = generate_pdf_bytes(report)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0

def test_generate_pdf_empty_report():
    report = ReportData()
    pdf_bytes = generate_pdf_bytes(report)
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 0

# --- API Router Tests ---

def test_api_generate_pdf_success():
    payload = {
        "report": {
            "repo_name": "test-repo",
            "repo_url": "https://github.com/test/repo",
            "executive_summary": "Clean backend with fast PDF generation."
        }
    }
    response = client.post("/api/generate-pdf", json=payload)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert len(response.content) > 0

def test_api_generate_pdf_empty_validation_error():
    # Report contains no content fields
    payload = {
        "report": {
            "repo_name": "empty-repo",
            "repo_url": ""
        }
    }
    response = client.post("/api/generate-pdf", json=payload)
    assert response.status_code == 400
    data = response.json()
    assert "detail" in data
    assert "no content fields" in data["detail"]

def test_api_generate_pdf_invalid_payload():
    # Completely missing report object
    payload = {}
    response = client.post("/api/generate-pdf", json=payload)
    assert response.status_code == 422  # Pydantic validation error
    data = response.json()
    assert "detail" in data
