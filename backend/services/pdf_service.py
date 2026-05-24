"""
OpenDoc - PDF Generation Service

Generates clean, professional PDF reports from ReportData
using fpdf2 (no system dependencies required).
"""

from fpdf import FPDF

from models.schemas import ReportData


class OpenDocPDF(FPDF):
    """Custom PDF class with OpenDoc branding."""

    def __init__(self):
        super().__init__()
        self.set_auto_page_break(auto=True, margin=20)

    def header(self):
        """Page header with OpenDoc branding."""
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(130, 130, 160)
        self.cell(0, 8, "OpenDoc - Project Intelligence Report", align="R")
        self.ln(4)
        self.set_draw_color(100, 90, 230)
        self.set_line_width(0.5)
        self.line(10, self.get_y(), self.w - 10, self.get_y())
        self.ln(8)

    def footer(self):
        """Page footer with page number."""
        self.set_y(-15)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(150, 150, 150)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

    def _safe(self, text: any) -> str:
        """Make text safe for latin-1 encoding."""
        if text is None:
            return ""
        # Convert non-string to string
        text_str = str(text)
        return text_str.encode("latin-1", errors="replace").decode("latin-1")

    def _section_title(self, title: str):
        """Render a section heading."""
        self.set_font("Helvetica", "B", 13)
        self.set_text_color(90, 80, 220)
        self.cell(0, 10, self._safe(title), new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(90, 80, 220)
        self.set_line_width(0.3)
        self.line(10, self.get_y(), 80, self.get_y())
        self.ln(4)

    def _sub_heading(self, title: str):
        """Render a sub-section heading."""
        self.set_font("Helvetica", "B", 10)
        self.set_text_color(70, 65, 180)
        self.cell(0, 8, self._safe(title), new_x="LMARGIN", new_y="NEXT")
        self.ln(2)

    def _body_text(self, text: str):
        """Render body paragraph text."""
        self.set_font("Helvetica", "", 10)
        self.set_text_color(50, 50, 50)
        self.multi_cell(0, 6, self._safe(text))
        self.ln(3)

    def _bullet_list(self, items: list):
        """Render a bulleted list."""
        if not items:
            return
        self.set_font("Helvetica", "", 10)
        self.set_text_color(50, 50, 50)
        for item in items:
            if item is None:
                continue
            self.multi_cell(0, 6, f"  -  {self._safe(item)}")
            self.ln(1)
        self.ln(3)


def generate_pdf_bytes(report: ReportData) -> bytes:
    """
    Generate a PDF document from a ReportData object.

    Returns:
        PDF file as bytes
    """
    pdf = OpenDocPDF()
    pdf.alias_nb_pages()
    pdf.add_page()

    # Title
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(30, 30, 50)
    repo_display = report.repo_name or "Repository Analysis"
    pdf.cell(0, 14, pdf._safe(repo_display), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    if report.repo_url:
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(100, 90, 230)
        pdf.cell(0, 6, pdf._safe(report.repo_url), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(8)

    # Executive Summary
    if report.executive_summary:
        pdf._section_title("Executive Summary")
        pdf._body_text(report.executive_summary)

    # What It Actually Is
    if report.what_it_actually_is:
        pdf._section_title("What The Project Actually Is")
        pdf._body_text(report.what_it_actually_is)

    # Project Maturity
    if report.project_maturity:
        pdf._section_title("Project Maturity")
        pdf._body_text(report.project_maturity)

    # Core Strengths
    if report.core_strengths:
        pdf._section_title("Core Strengths")
        pdf._bullet_list(report.core_strengths)

    # Engineering Assessment
    if report.engineering_assessment:
        pdf._section_title("Engineering Assessment")
        pdf._body_text(report.engineering_assessment)

    # Engineering Patterns
    if report.engineering_patterns:
        pdf._section_title("Engineering Patterns")
        pdf._bullet_list(report.engineering_patterns)

    # Architecture Observations
    if report.architecture_observations:
        pdf._section_title("Architecture Observations")
        pdf._bullet_list(report.architecture_observations)

    # Scope vs Execution
    if report.scope_vs_execution:
        pdf._section_title("Scope vs Execution")
        pdf._body_text(report.scope_vs_execution)

    # Product Direction
    if report.product_direction:
        pdf._section_title("Product Direction")
        pd = report.product_direction
        if pd.strongest_direction:
            pdf._sub_heading("Strongest Direction")
            pdf._body_text(pd.strongest_direction)
        if pd.highest_impact_next_step:
            pdf._sub_heading("Highest Impact Next Step")
            pdf._body_text(pd.highest_impact_next_step)
        if pd.biggest_technical_risk:
            pdf._sub_heading("Biggest Technical Risk")
            pdf._body_text(pd.biggest_technical_risk)
        if pd.most_impressive_aspect:
            pdf._sub_heading("Most Impressive Aspect")
            pdf._body_text(pd.most_impressive_aspect)
        if pd.most_underrated_feature:
            pdf._sub_heading("Most Underrated Feature")
            pdf._body_text(pd.most_underrated_feature)

    # Biggest Risks
    if report.biggest_risks:
        pdf._section_title("Biggest Risks")
        pdf._bullet_list(report.biggest_risks)

    # Repeated Concepts
    if report.repeated_concepts:
        pdf._section_title("Repeated Concepts")
        pdf._bullet_list(report.repeated_concepts)

    # Learning Areas
    if report.learning_areas:
        pdf._section_title("Learning Areas")
        pdf._bullet_list(report.learning_areas)

    # Recommended Next Step
    if report.recommended_next_step:
        pdf._section_title("Recommended Next Step")
        pdf._body_text(report.recommended_next_step)

    # Portfolio Assessment
    if report.portfolio_assessment:
        pdf._section_title("Portfolio Assessment")
        pdf._body_text(report.portfolio_assessment)

    # Developer Intelligence
    if report.developer_intelligence:
        pdf._section_title("Developer Intelligence")
        pdf._body_text(report.developer_intelligence)

    # Final Verdict
    if report.final_verdict:
        pdf._section_title("Final Verdict")
        pdf._body_text(report.final_verdict)

    return bytes(pdf.output())
