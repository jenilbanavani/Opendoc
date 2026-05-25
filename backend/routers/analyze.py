"""
OpenDoc — API Router for Analysis Endpoints

Provides the /analyze and /generate-pdf endpoints.
"""

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from models.schemas import (
    AnalyzeRequest,
    AnalyzeLocalRequest,
    AnalyzeResponse,
    PDFRequest,
    ReportData,
    DevNotesRequest,
    DevNotesResponse,
    SnapshotRequest,
    SnapshotResponse,
    NotesListResponse,
    NoteVersionItem,
)
from services.github_service import build_repo_context, parse_github_url
from services.ai_service import generate_report
from services.pdf_service import generate_pdf_bytes
from services.dev_notes_service import generate_dev_notes
from services.snapshot_service import process_snapshot
from services.db_service import get_note_versions

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_repository(request: AnalyzeRequest):
    """
    Analyze a GitHub repository and generate an AI-powered intelligence report.

    1. Parses the GitHub URL
    2. Fetches repository context (metadata, key files, commits)
    3. Sends context to Groq AI for analysis
    4. Returns structured report
    """
    try:
        # Validate URL
        owner, repo = parse_github_url(request.repo_url)
        logger.info(f"Analyzing repository: {owner}/{repo}")

        # Fetch repository context
        repo_context = await build_repo_context(request.repo_url)
        logger.info(
            f"Fetched context: {len(repo_context['key_files'])} key files, "
            f"{len(repo_context['recent_commits'])} commits"
        )

        # Generate AI report
        report = await generate_report(
            context_string=repo_context["context_string"],
            provider=request.provider,
            model=request.model,
            api_key=request.api_key,
            repo_name=repo_context["metadata"]["full_name"],
            repo_url=repo_context["metadata"]["url"],
            report_mode=request.report_mode,
            custom_sections=request.custom_sections,
        )

        return AnalyzeResponse(success=True, report=report)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception(f"Unexpected error analyzing {request.repo_url}")
        raise HTTPException(
            status_code=500,
            detail=f"An unexpected error occurred: {str(e)}",
        )


@router.post("/analyze-local", response_model=AnalyzeResponse)
async def analyze_local_project(request: AnalyzeLocalRequest):
    """
    Analyze a local project from VS Code extension.

    Accepts pre-built context (folder structure + key file contents)
    sent by the VS Code extension and generates an AI report.
    """
    try:
        logger.info(f"Analyzing local project: {request.project_name}")

        # Build context string from local project data
        context_parts = []

        context_parts.append("=== PROJECT METADATA ===")
        context_parts.append(f"Name: {request.project_name}")
        context_parts.append(f"Source: Local workspace (VS Code)")
        context_parts.append("")

        context_parts.append("=== FILE STRUCTURE ===")
        context_parts.append(request.folder_structure)
        context_parts.append("")

        for fname, content in request.files.items():
            context_parts.append(f"=== FILE: {fname} ===")
            context_parts.append(content)
            context_parts.append("")

        context_string = "\n".join(context_parts)

        # Trim if too long
        if len(context_string) > 12000:
            context_string = (
                context_string[:12000]
                + "\n\n[... context trimmed for token economy ...]"
            )

        # Generate AI report using existing service
        report = await generate_report(
            context_string=context_string,
            provider=request.provider,
            model=request.model,
            api_key=request.api_key,
            repo_name=request.project_name,
            repo_url=f"local://{request.project_name}",
            report_mode=request.report_mode,
            custom_sections=request.custom_sections,
        )

        return AnalyzeResponse(success=True, report=report)

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception(f"Unexpected error analyzing local project {request.project_name}")
        raise HTTPException(
            status_code=500,
            detail=f"An unexpected error occurred: {str(e)}",
        )



@router.post("/generate-dev-notes", response_model=DevNotesResponse)
async def generate_session_dev_notes(request: DevNotesRequest):
    """
    Generate development notes based on session coding activity (tracked files, imports, functions).
    """
    try:
        logger.info(f"Generating dev notes for workspace: {request.project_name}")
        
        notes = await generate_dev_notes(
            project_name=request.project_name,
            tracked_files=request.tracked_files,
            provider=request.provider,
            model=request.model,
            api_key=request.api_key,
        )
        
        return DevNotesResponse(success=True, dev_notes=notes)
        
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.exception(f"Unexpected error generating dev notes for {request.project_name}")
        raise HTTPException(
            status_code=500,
            detail=f"An unexpected error occurred: {str(e)}",
        )


@router.post("/generate-pdf")
async def generate_pdf(request: PDFRequest):
    """
    Generate a PDF document from a previously generated report.

    Accepts the full report data and returns a downloadable PDF.
    """
    report = request.report
    logger.info(
        f"Received PDF generation request. Payload: repo_name='{report.repo_name}', "
        f"repo_url='{report.repo_url}', mode='{report.report_mode or 'unknown'}'"
    )

    try:
        # Validate report content has at least some analysis data
        content_fields = [
            report.executive_summary,
            report.what_it_actually_is,
            report.project_maturity,
            report.engineering_assessment,
            report.portfolio_assessment,
            report.developer_intelligence,
            report.final_verdict,
            report.core_strengths,
            report.biggest_risks,
            report.product_direction,
            report.engineering_patterns,
            report.architecture_observations,
            report.repeated_concepts,
            report.learning_areas,
        ]
        if not any(content_fields):
            logger.warning(f"PDF generation failed: Report contains no content fields for '{report.repo_name}'")
            raise HTTPException(
                status_code=400,
                detail="Cannot generate PDF: Report contains no content fields.",
            )

        pdf_bytes = generate_pdf_bytes(report)

        filename = report.repo_name.replace("/", "_") or "opendoc_report"
        logger.info(
            f"PDF generation successful for '{report.repo_name}' (mode: '{report.report_mode or 'unknown'}'). "
            f"Size: {len(pdf_bytes)} bytes."
        )

        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}_report.pdf"'
            },
        )

    except HTTPException as e:
        # Re-raise HTTPExceptions directly to prevent double-wrapping
        raise e
    except Exception as e:
        logger.exception(f"PDF generation failed for repo '{report.repo_name}'")
        raise HTTPException(
            status_code=500,
            detail=f"PDF generation failed: {str(e)}",
        )


@router.post("/session/snapshot", response_model=SnapshotResponse)
async def save_session_snapshot(request: SnapshotRequest):
    """
    Receive a session workspace snapshot from the VS Code extension.
    Saves the files/functions and optionally generates an AI diff note version.
    """
    try:
        logger.info(f"Received snapshot save request for session: {request.session_id}")
        
        # Convert Pydantic file list to plain list of dicts for the service
        files_list = [{"filename": f.filename, "functions": f.functions, "hash": f.hash} for f in request.files]
        
        new_note = await process_snapshot(
            session_id=request.session_id,
            timestamp=request.timestamp,
            goal=request.goal or "",
            files=files_list,
            provider=request.provider,
            model=request.model,
            api_key=request.api_key,
        )
        
        return SnapshotResponse(success=True, new_note=new_note)
        
    except Exception as e:
        logger.exception(f"Unexpected error saving snapshot for session {request.session_id}")
        return SnapshotResponse(success=False, error=str(e))


@router.get("/session/notes", response_model=NotesListResponse)
async def get_session_notes(session_id: str):
    """
    Retrieve all AI generated note versions for a specific session.
    """
    try:
        logger.info(f"Retrieving note versions for session: {session_id}")
        notes = get_note_versions(session_id)
        
        # Map to response objects
        note_items = [
            NoteVersionItem(
                timestamp=note["timestamp"],
                summary=note["summary"],
                goal=note.get("goal")
            )
            for note in notes
        ]
        
        return NotesListResponse(success=True, notes=note_items)
        
    except Exception as e:
        logger.exception(f"Unexpected error fetching notes for session {session_id}")
        return NotesListResponse(success=False, error=str(e))

