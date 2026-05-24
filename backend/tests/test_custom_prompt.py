"""
Tests for the custom report prompt builder and field filtering.
"""

import json
import re
import pytest

from prompts.custom_prompt import (
    build_custom_prompt,
    get_fields_for_sections,
    SECTION_REGISTRY,
    BASELINE_FIELDS,
)


class TestGetFieldsForSections:
    """Test that get_fields_for_sections returns exactly the right field sets."""

    def test_empty_sections_returns_only_baseline(self):
        result = get_fields_for_sections([])
        assert result == set(BASELINE_FIELDS)

    def test_architecture_notes(self):
        result = get_fields_for_sections(["architecture_notes"])
        expected = set(BASELINE_FIELDS) | {
            "engineering_assessment",
            "engineering_patterns",
            "architecture_observations",
        }
        assert result == expected

    def test_risks_only(self):
        result = get_fields_for_sections(["risks"])
        expected = set(BASELINE_FIELDS) | {"biggest_risks"}
        assert result == expected

    def test_learning_insights(self):
        result = get_fields_for_sections(["learning_insights"])
        expected = set(BASELINE_FIELDS) | {"learning_areas", "repeated_concepts"}
        assert result == expected

    def test_startup_analysis(self):
        result = get_fields_for_sections(["startup_analysis"])
        expected = set(BASELINE_FIELDS) | {"product_direction"}
        assert result == expected

    def test_developer_notes(self):
        result = get_fields_for_sections(["developer_notes"])
        expected = set(BASELINE_FIELDS) | {
            "developer_intelligence",
            "portfolio_assessment",
        }
        assert result == expected

    def test_roadmap_suggestions(self):
        result = get_fields_for_sections(["roadmap_suggestions"])
        expected = set(BASELINE_FIELDS) | {"recommended_next_step"}
        assert result == expected

    def test_multiple_sections_combined(self):
        result = get_fields_for_sections(["risks", "learning_insights"])
        expected = set(BASELINE_FIELDS) | {
            "biggest_risks",
            "learning_areas",
            "repeated_concepts",
        }
        assert result == expected

    def test_all_sections(self):
        all_keys = list(SECTION_REGISTRY.keys())
        result = get_fields_for_sections(all_keys)
        # Should contain baseline + all section fields
        assert set(BASELINE_FIELDS).issubset(result)
        for entry in SECTION_REGISTRY.values():
            for field in entry["fields"]:
                assert field in result

    def test_unknown_section_ignored(self):
        result = get_fields_for_sections(["nonexistent_section"])
        assert result == set(BASELINE_FIELDS)

    def test_strengths_weaknesses_includes_both(self):
        result = get_fields_for_sections(["strengths_weaknesses"])
        assert "core_strengths" in result
        assert "biggest_risks" in result


class TestBuildCustomPrompt:
    """Test that build_custom_prompt generates correct prompts."""

    def test_empty_sections_produces_baseline_only_schema(self):
        prompt = build_custom_prompt([])
        # Should contain baseline keys
        assert '"executive_summary"' in prompt
        assert '"what_it_actually_is"' in prompt
        assert '"final_verdict"' in prompt
        # Should NOT contain non-baseline keys
        assert '"engineering_assessment"' not in prompt
        assert '"biggest_risks"' not in prompt
        assert '"learning_areas"' not in prompt
        assert '"product_direction"' not in prompt

    def test_architecture_prompt_includes_correct_keys(self):
        prompt = build_custom_prompt(["architecture_notes"])
        # Baseline
        assert '"executive_summary"' in prompt
        assert '"final_verdict"' in prompt
        # Architecture-specific
        assert '"engineering_assessment"' in prompt
        assert '"engineering_patterns"' in prompt
        assert '"architecture_observations"' in prompt
        # Should NOT include unrelated sections
        assert '"biggest_risks"' not in prompt
        assert '"learning_areas"' not in prompt
        assert '"product_direction"' not in prompt

    def test_risks_prompt_excludes_architecture(self):
        prompt = build_custom_prompt(["risks"])
        assert '"biggest_risks"' in prompt
        assert '"engineering_assessment"' not in prompt
        assert '"architecture_observations"' not in prompt

    def test_prompt_contains_no_extra_keys_instruction(self):
        prompt = build_custom_prompt(["risks"])
        assert "Do NOT add any keys beyond those listed" in prompt

    def test_startup_analysis_includes_nested_product_direction(self):
        prompt = build_custom_prompt(["startup_analysis"])
        assert '"product_direction"' in prompt
        assert '"strongest_direction"' in prompt
        assert '"highest_impact_next_step"' in prompt

    def test_multiple_sections_merge_schemas(self):
        prompt = build_custom_prompt(["risks", "learning_insights", "roadmap_suggestions"])
        assert '"biggest_risks"' in prompt
        assert '"learning_areas"' in prompt
        assert '"repeated_concepts"' in prompt
        assert '"recommended_next_step"' in prompt
        # Should NOT include unselected
        assert '"engineering_assessment"' not in prompt
        assert '"product_direction"' not in prompt

    def test_prompt_is_valid_string(self):
        prompt = build_custom_prompt(["architecture_notes", "risks"])
        assert isinstance(prompt, str)
        assert len(prompt) > 100

    def test_empty_sections_has_overview_focus(self):
        prompt = build_custom_prompt([])
        assert "high-level overview" in prompt

    def test_selected_sections_has_focus_instructions(self):
        prompt = build_custom_prompt(["architecture_notes"])
        assert "Focus your analysis on ONLY these areas" in prompt


class TestFieldFilteringIntegration:
    """Test that field filtering correctly prunes a mock LLM response."""

    def test_filter_removes_unselected_fields(self):
        # Simulate an LLM response that includes everything
        mock_response = {
            "executive_summary": "Great project",
            "what_it_actually_is": "A web app",
            "final_verdict": "Solid work",
            "engineering_assessment": "Well structured",
            "biggest_risks": ["Overengineering"],
            "learning_areas": ["Testing"],
            "product_direction": {"strongest_direction": "API"},
            "developer_intelligence": "Experienced",
        }

        # User only selected architecture_notes
        allowed = get_fields_for_sections(["architecture_notes"])
        filtered = {k: v for k, v in mock_response.items() if k in allowed}

        # Should keep baseline + architecture fields
        assert "executive_summary" in filtered
        assert "what_it_actually_is" in filtered
        assert "final_verdict" in filtered
        assert "engineering_assessment" in filtered

        # Should remove everything else
        assert "biggest_risks" not in filtered
        assert "learning_areas" not in filtered
        assert "product_direction" not in filtered
        assert "developer_intelligence" not in filtered

    def test_filter_with_no_sections_keeps_only_baseline(self):
        mock_response = {
            "executive_summary": "Summary",
            "what_it_actually_is": "Description",
            "final_verdict": "Verdict",
            "biggest_risks": ["Risk 1"],
            "core_strengths": ["Strength 1"],
        }

        allowed = get_fields_for_sections([])
        filtered = {k: v for k, v in mock_response.items() if k in allowed}

        assert len(filtered) == 3
        assert "biggest_risks" not in filtered
        assert "core_strengths" not in filtered
