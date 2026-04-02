"""Quick diagnostic: test precall PDF generation directly."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

# Minimal brief that mirrors what the DB would return
TEST_BRIEF = {
    "company_name": "Test Corp",
    "call_type": "discovery",
    "north_star": "Confirm the technical owner and whether their AI platform has observable infrastructure.",
    "situation_summary": "Test Corp is an existing customer. This call is with a new contact outside the main DD team.",
    "what_we_know": ["They are an existing Datadog customer", "Contact is Director of Training"],
    "what_we_dont_know": ["Whether they have software infrastructure", "Who the technical owner is"],
    "call_objectives": ["Confirm AI platform scope", "Identify technical owner", "Determine commercial vs GovCloud"],
    "questions_to_ask": [
        {"question": "What does the AI platform actually run on?", "strategic_purpose": "Understand if there is real infra to observe", "follow_up_if": "If they mention APIs or model endpoints, ask about logging"},
        {"question": "Who owns the infrastructure side?", "strategic_purpose": "Find the real technical champion", "follow_up_if": None},
    ],
    "attendee_prep": [
        {"name": "Amy Wood", "inferred_role": "Director of Training", "what_they_care_about": "Learning and development outcomes", "how_to_engage": "Lead with AI use cases not infrastructure"},
    ],
    "things_to_avoid": ["Pitching core Datadog APM before confirming there is infra to monitor", "Assuming she is a technical buyer"],
    "key_proof_points": ["Datadog LLM Observability for AI/ML platforms", "Case study: fintech firm monitoring model endpoints"],
    "processing_time_ms": 5000,
}

print("Testing PDF generation...")
try:
    from precall_export import generate_precall_pdf
    path = generate_precall_pdf("test-diag-001", TEST_BRIEF)
    print(f"SUCCESS: PDF written to {path}")
except Exception as e:
    import traceback
    print(f"FAILED: {e}")
    traceback.print_exc()
