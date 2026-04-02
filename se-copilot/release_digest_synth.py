"""Release Notes Digest — fetches the Datadog RSS feed, scores each release
against customer context, and synthesizes a personalized newsletter digest."""

from __future__ import annotations

import json
import logging
import re
import xml.etree.ElementTree as ET

import anthropic
import httpx

from anthropic_helpers import extract_text
from config import settings
from release_digest_models import ReleaseItem, RelevantRelease

logger = logging.getLogger(__name__)

_FENCE_RE = re.compile(r"^```(?:json)?\s*\n(.*?)\n```\s*$", re.DOTALL)
DD_RSS_URL = "https://www.datadoghq.com/release-notes-feed?app=datadoghq.com&subdomain=demo"


def _strip_fences(text: str) -> str:
    m = _FENCE_RE.match(text.strip())
    return m.group(1).strip() if m else text.strip()


# ---------------------------------------------------------------------------
# RSS Fetcher
# ---------------------------------------------------------------------------

# Matches <a href="...">...</a> inside CDATA description HTML
_HREF_RE = re.compile(r'<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
# Strip all HTML tags for plain-text summary
_TAG_RE = re.compile(r'<[^>]+>')


def _extract_feed_links(html: str) -> list[dict]:
    """Extract all hrefs from CDATA HTML, deduped, with link text."""
    seen: set[str] = set()
    links: list[dict] = []
    for url, raw_text in _HREF_RE.findall(html):
        url = url.strip()
        text = _TAG_RE.sub("", raw_text).strip()
        if url and url not in seen:
            seen.add(url)
            links.append({"url": url, "text": text or url})
    return links


def _html_to_text(html: str) -> str:
    """Strip HTML tags and collapse whitespace for plain-text summary."""
    text = _TAG_RE.sub(" ", html)
    return re.sub(r'\s+', ' ', text).strip()


async def fetch_release_notes(max_items: int = 20) -> list[ReleaseItem]:
    """Fetch and parse the Datadog release notes RSS feed."""
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(DD_RSS_URL)
            resp.raise_for_status()
            xml_content = resp.text

        root = ET.fromstring(xml_content)
        channel = root.find("channel")
        if channel is None:
            logger.warning("RSS feed: no <channel> element found")
            return []

        items: list[ReleaseItem] = []
        for item_el in channel.findall("item")[:max_items]:
            def _text(tag: str) -> str:
                el = item_el.find(tag)
                return (el.text or "").strip() if el is not None else ""

            # Permalink lives in <guid>, not <link> (which is the channel URL)
            guid_el = item_el.find("guid")
            permalink = (guid_el.text or "").strip() if guid_el is not None else ""

            # Description is CDATA HTML — extract plain text and all hrefs
            desc_el = item_el.find("description")
            desc_html = (desc_el.text or "") if desc_el is not None else ""
            feed_links = _extract_feed_links(desc_html)
            plain_summary = _html_to_text(desc_html)

            items.append(ReleaseItem(
                title=_text("title"),
                link=permalink,
                published=_text("pubDate"),
                summary=plain_summary[:600],
                feed_links=feed_links,
            ))

        logger.info("Fetched %d release notes from RSS feed", len(items))
        return items

    except Exception as exc:
        logger.error("Failed to fetch Datadog release notes RSS: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Context Extractors
# ---------------------------------------------------------------------------

def _extract_customer_intelligence(
    company_name: str,
    hypothesis: dict | None,
    call_notes: list[dict],
    demo_plan: dict | None,
    additional_context: str = "",
    slack_summaries: list[dict] | None = None,
) -> str:
    """
    Build a rich, structured intelligence brief about the customer.
    The goal is to surface every specific, named, quotable fact that Claude
    can use as a hook when scoring releases — not generic descriptions.
    """
    sections: list[str] = [f"CUSTOMER: {company_name}"]

    # --- Hypothesis intel ---
    if hypothesis:
        rs = hypothesis.get("research_summary", {})
        md = hypothesis.get("hypothesis_markdown", "")
        confidence = hypothesis.get("confidence_level", "unknown")
        industry = rs.get("industry", "")
        is_public = rs.get("is_public", False)

        h_parts = [f"ACCOUNT INTELLIGENCE (confidence: {confidence})"]
        if industry:
            h_parts.append(f"Industry: {industry}")
        if is_public:
            h_parts.append("Public company (SEC filings available)")

        # Tech stack — be specific
        obs_tools = rs.get("current_observability_tools", [])
        cloud = rs.get("current_cloud_platforms", [])
        infra = rs.get("current_infrastructure", [])
        dbs = rs.get("current_databases", [])
        langs = rs.get("current_languages", [])
        cicd = rs.get("current_cicd_tools", [])
        queues = rs.get("current_message_queues", [])
        serverless = rs.get("current_serverless", [])

        if obs_tools:
            h_parts.append(f"Current observability tools (potential displacement): {', '.join(obs_tools)}")
        if cloud:
            h_parts.append(f"Cloud platforms: {', '.join(cloud)}")
        if infra:
            h_parts.append(f"Infrastructure: {', '.join(infra)}")
        if dbs:
            h_parts.append(f"Databases: {', '.join(dbs)}")
        if langs:
            h_parts.append(f"Languages/frameworks: {', '.join(langs)}")
        if cicd:
            h_parts.append(f"CI/CD tools: {', '.join(cicd)}")
        if queues:
            h_parts.append(f"Message queues/streaming: {', '.join(queues)}")
        if serverless:
            h_parts.append(f"Serverless: {', '.join(serverless)}")

        competitive = rs.get("competitive_displacement_targets", [])
        if competitive:
            h_parts.append(f"Competitive displacement targets: {', '.join(competitive)}")

        strategic = rs.get("strategic_priorities", [])
        if strategic:
            h_parts.append(f"Strategic priorities: {', '.join(strategic[:5])}")

        # Personas
        entry = rs.get("recommended_entry_persona", {})
        if entry.get("title"):
            h_parts.append(f"Primary buyer: {entry['title']}")
            if entry.get("rationale"):
                h_parts.append(f"  Why: {entry['rationale']}")

        key_personas = rs.get("key_personas", [])
        if key_personas:
            persona_lines = []
            for p in key_personas[:4]:
                t = p.get("title", "")
                kpis = p.get("kpis", [])
                if t:
                    persona_lines.append(f"{t}" + (f" (KPIs: {', '.join(kpis[:2])})" if kpis else ""))
            if persona_lines:
                h_parts.append(f"Key stakeholder personas: {'; '.join(persona_lines)}")

        # Hiring signals
        hiring = rs.get("key_hiring_themes", [])
        if hiring:
            h_parts.append(f"Hiring themes (signals investment areas): {', '.join(hiring[:5])}")

        open_roles = rs.get("relevant_open_roles", [])
        if open_roles:
            role_strs = [f"{r.get('title','?')} ({r.get('department','')})" for r in open_roles[:5]]
            h_parts.append(f"Key open roles: {'; '.join(role_strs)}")

        # Hypothesis narrative (most valuable — contains the SE's synthesis)
        if md:
            h_parts.append(f"\nHypothesis narrative (read carefully — this contains the SE's strategic assessment):\n{md[:3000]}")

        sections.append("\n".join(h_parts))

    # --- Call notes — extract the richest signals ---
    if call_notes:
        cn_parts = ["CALL HISTORY (extract specific pains, objections, named people, verbatim signals):"]
        for i, note in enumerate(call_notes[:4]):
            created = note.get("created_at", "")[:10]
            title = note.get("title") or f"Call {i+1}"
            cn_parts.append(f"\n--- {title} ({created}) ---")
            summary_raw = note.get("summary_markdown", "")
            if not summary_raw:
                cn_parts.append("  (no summary available)")
                continue
            try:
                s = json.loads(summary_raw)

                # Call context
                ctx = s.get("call_context", {})
                if ctx.get("call_type"):
                    cn_parts.append(f"  Call type: {ctx['call_type']}")
                if ctx.get("attendees"):
                    cn_parts.append(f"  Attendees: {', '.join(ctx['attendees'][:6])}")

                # Pain points — most valuable for scoring
                pains = s.get("pain_points", [])
                for p in pains[:5]:
                    urgency = p.get("urgency", "?")
                    pain = p.get("pain", "")
                    detail = p.get("detail", "")
                    owner = p.get("pain_owner", "")
                    cn_parts.append(
                        f"  PAIN [{urgency}]{' (' + owner + ')' if owner else ''}: {pain}"
                        + (f"\n    Detail: {detail}" if detail else "")
                    )

                # Objections
                objections = s.get("objections", [])
                for o in objections[:3]:
                    cn_parts.append(f"  OBJECTION [{o.get('status','?')}]: {o.get('objection','')}")

                # Signal log — open questions and competitor mentions
                sig = s.get("signal_log", {})
                open_qs = sig.get("open_questions", [])
                for q in open_qs[:4]:
                    cn_parts.append(f"  OPEN QUESTION: {q}")
                competitors = sig.get("competitor_mentions", [])
                if competitors:
                    cn_parts.append(f"  COMPETITORS MENTIONED: {', '.join(competitors)}")

                # SE notes — often the most candid assessment
                se_notes = s.get("se_notes", "")
                if se_notes:
                    cn_parts.append(f"  SE NOTES: {se_notes[:600]}")

                # Next steps committed
                next_steps = s.get("next_steps", [])
                for ns in next_steps[:3]:
                    cn_parts.append(
                        f"  COMMITTED NEXT STEP [{ns.get('owner_side','?')}]: {ns.get('action','')}"
                        + (f" by {ns.get('due_date','')}" if ns.get("due_date") else "")
                    )

            except (json.JSONDecodeError, TypeError):
                cn_parts.append(f"  {summary_raw[:500]}")
        sections.append("\n".join(cn_parts))
    else:
        sections.append("CALL HISTORY: No call notes captured yet.")

    # --- Demo plan ---
    if demo_plan:
        persona = demo_plan.get("persona", "")
        mode = demo_plan.get("demo_mode", "")
        md = (demo_plan.get("markdown", "") or demo_plan.get("demo_plan", ""))[:1500]
        sections.append(
            f"DEMO PLAN (Persona: {persona}, Mode: {mode}):\n{md}"
        )

    # --- SE's additional context ---
    if additional_context:
        sections.append(f"SE'S ADDITIONAL CONTEXT (treat as high-signal):\n{additional_context}")

    # --- Slack channel summaries — most recent internal team intelligence ---
    if slack_summaries:
        slack_parts = [
            f"INTERNAL SLACK DISCUSSION ({len(slack_summaries)} summary{'s' if len(slack_summaries) != 1 else ''}, "
            f"most recent first — treat as the highest-confidence, most current context about this account):"
        ]
        for s in slack_summaries[:5]:
            created = s.get("updated_at", s.get("created_at", ""))[:10]
            channel = s.get("channel_name", "").strip()
            slack_parts.append(f"\n--- {channel or 'Slack'} ({created}) ---")
            text = s.get("summary_text", "").strip()
            if text:
                for line in text.splitlines():
                    slack_parts.append(f"  {line}" if line.strip() else "")
        sections.append("\n".join(slack_parts))

    return "\n\n".join(sections)


def _format_releases_for_scoring(items: list[ReleaseItem]) -> str:
    lines = []
    for i, item in enumerate(items):
        block = (
            f"[{i}] TITLE: {item.title}\n"
            f"    DATE: {item.published}\n"
            f"    RELEASE PAGE: {item.link}\n"
            f"    SUMMARY: {item.summary[:500]}\n"
        )
        if item.feed_links:
            # Surface docs and blog links from the feed so the scorer can reference them
            link_lines = []
            for lnk in item.feed_links:
                url = lnk["url"]
                text = lnk["text"]
                # Classify so Claude knows which is which
                if "docs.datadoghq.com" in url:
                    kind = "DOCS"
                elif "datadoghq.com/blog" in url:
                    kind = "BLOG"
                elif "github.com" in url:
                    kind = "SDK/CHANGELOG"
                else:
                    kind = "LINK"
                link_lines.append(f"      [{kind}] {text}: {url}")
            block += "    LINKS FROM FEED:\n" + "\n".join(link_lines) + "\n"
        lines.append(block)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# System Prompts
# ---------------------------------------------------------------------------

SCORER_SYSTEM_PROMPT = """\
You are a Sales Engineer writing a personalized Datadog product update for a specific customer.
You have deep account intelligence: their tech stack, business pains, named stakeholders, \
call history, competitive context, and strategic priorities.

Your job: score each release note 1-10 for relevance to THIS customer, and write the \
customer-specific annotation that will appear in their newsletter.

---

SCORING SCALE:
10  — Directly addresses a confirmed, named pain from a call note or a hard compliance/regulatory \
      requirement specific to this customer's industry
9   — Closes a known competitive gap (a tool they use that Datadog is displacing), or unblocks \
      a known initiative they've explicitly discussed
7-8 — Relevant to their confirmed tech stack, a named persona's KPIs, or a hiring signal that \
      reveals investment direction
5-6 — Tangentially relevant; the SE would need to stretch to connect it, but a hook exists
1-4 — No meaningful connection to this customer's context; do not include

---

WRITING RULES — why_it_matters (2-3 sentences, CUSTOMER-FACING):

This text appears verbatim in a newsletter sent directly to the customer. Write as if \
addressing the customer directly, not briefing an SE. The customer should feel like you \
understand their specific environment and have curated this release specifically for them.

RULE 1: CAUSE → EFFECT STRUCTURE. Start with a specific fact about this customer's \
environment or a real conversation touchpoint, then explain what this release means for them.
  ✓ "Your team operates in a regulated healthcare environment with PHI access requirements — \
     FIPS 140-2 compliant Windows private locations means you can deploy synthetic workers \
     inside your environment without a compliance exception."
  ✗ "This feature improves observability for healthcare teams."

RULE 2: USE NAMED DETAILS. Reference named people, named tools, named initiatives, \
specific metrics (e.g. "the 4-5 hour detection gap"), or regulatory requirements. \
This shows genuine preparation, not a generic blast.

RULE 3: NEVER FABRICATE. Only reference things that appear in the customer intelligence. \
If you have to invent context, the score should be ≤4.

RULE 4: ONE CLEAR MECHANISM. Explain HOW the release helps, not just that it does.

RULE 5: NEVER REFERENCE INTERNAL SOURCES OR REASONING. The why_it_matters text \
is sent directly to the customer. They must never see anything that reveals how \
you gathered your intelligence or what internal artifacts exist.

  NEVER reference:
  - Internal discussions, Slack, or team channels of any kind \
    ("per the Slack discussion", "as discussed internally", "your team mentioned in Slack", \
    "the Slack channel confirms", "our internal notes show")
  - Specific call note dates or artifact labels \
    ("the Jan 15 call note", "per the hypothesis", "based on our hypothesis", \
    "call note from March", "as noted in the hypothesis", "your call notes show")
  - Artifact system names \
    ("based on the Sales Hypothesis", "per the Expansion Playbook", \
    "your call notes captured", "SE notes indicate")
  - Qualifiers about data confidence or internal coverage gaps \
    ("no specific stakeholder was named", "no initiative around X was mentioned", \
    "this is a forward-looking fit", "no specific need was named", "based on weak signal", \
    "however, no X was confirmed")
  - Internal hedges or relevance caveats \
    ("this is a moderate fit", "this is tangentially relevant", "the SE would need to stretch")
  - Scoring or threshold references

  HOW TO USE SLACK AND CALL INTELLIGENCE CORRECTLY:
  Extract the facts, use them to write specific customer-facing claims, but attribute \
  nothing to their source. The intelligence informs the specificity — it does not appear.
  ✓ WRONG: "This is especially relevant given the Slack discussion confirming that longer \
           span retention periods are not currently being billed."
  ✓ WRONG: "Your team flagged in our last call that the 4-5 hour detection gap is a \
           known issue — this release addresses that directly."
  ✓ RIGHT: "Your team operates in a complex multi-service environment where detection \
           gaps during low-traffic windows have been an ongoing challenge — this release \
           directly reduces time-to-root-cause in exactly those scenarios."
  ✓ RIGHT: "Given your current span retention setup, this release makes it a good time \
           to establish intentional retention policies before usage scales further."

  The test: read why_it_matters as if you are the customer receiving this email. \
  Does any sentence reveal internal team discussions, tool names, or documentation? \
  If yes, rewrite it to communicate the same insight without the source reference.

  If you cannot write a clean customer-facing sentence without referencing internal sources, \
  lower the relevance score instead of including a qualified sentence.

---

WRITING RULES — talk_track (1-2 sentences, SE-internal, conversational):

The talk_track is for SE eyes only and never sent to the customer. It is the SE's \
prepared talking point for bringing this up naturally on a call.

RULE 1: Start with "Given [specific customer truth]..." or "Since [specific fact]..."
RULE 2: Address it to a named persona or team if possible.
RULE 3: It should be something an SE could say naturally on a call — not a marketing sentence.
RULE 4: You MAY reference what came up in conversations, but do NOT reference Slack, \
internal team discussions, or internal tool names. Frame it as "Given what came up \
on your last call" or "Since you've mentioned X" — not "per the Slack channel" or \
"as noted in our internal notes."
  ✓ "Given your healthcare compliance requirements and the push to expand synthetic coverage \
     beyond basic HTTP checks, FIPS-compliant Windows private locations means you can deploy \
     synthetic workers inside your regulated environment without a compliance exception."
  ✗ "This feature enables teams to run compliant workloads in regulated environments."

---

CATEGORIZE each release into one of: APM, Infrastructure, Logs, RUM, Security, Synthetics, \
Databases, Network Monitoring, CI Visibility, Cloud Cost, Platform/Admin, AI/ML Observability, \
Integrations, or Other.

---

DOCS LINK RULES:

For each release, provide a docs_link — the best docs.datadoghq.com URL for this feature.

IMPORTANT: Each release above may include a "LINKS FROM FEED" section. If a [DOCS] link \
appears there, use it as docs_link — it is the authoritative link supplied by Datadog directly \
in the release. Only fall back to constructing a URL from the base paths below when no [DOCS] \
link is present in the feed.

Use ONLY these known-good base paths. Every URL you produce MUST start with one of these:
- APM / tracing:        https://docs.datadoghq.com/tracing/
- Infrastructure:       https://docs.datadoghq.com/infrastructure/
- Logs:                 https://docs.datadoghq.com/logs/
- RUM:                  https://docs.datadoghq.com/real_user_monitoring/
- Security (SIEM):      https://docs.datadoghq.com/security/
- Synthetics:           https://docs.datadoghq.com/synthetics/
- Databases:            https://docs.datadoghq.com/database_monitoring/
- Network Monitoring:   https://docs.datadoghq.com/network_monitoring/
- CI Visibility:        https://docs.datadoghq.com/continuous_integration/
- Cloud Cost:           https://docs.datadoghq.com/cloud_cost_management/
- Account/Admin:        https://docs.datadoghq.com/account_management/
- AI/LLM Observability: https://docs.datadoghq.com/llm_observability/
- Integrations:         https://docs.datadoghq.com/integrations/
- Monitors:             https://docs.datadoghq.com/monitors/
- Dashboards:           https://docs.datadoghq.com/dashboards/
- Incidents:            https://docs.datadoghq.com/service_management/incident_management/
- On-Call:              https://docs.datadoghq.com/service_management/on-call/
- Status Pages:         https://docs.datadoghq.com/incident_response/status_pages/
- SLOs:                 https://docs.datadoghq.com/service_management/service_level_objectives/
- Watchdog:             https://docs.datadoghq.com/watchdog/
- Error Tracking:       https://docs.datadoghq.com/error_tracking/
- Profiling:            https://docs.datadoghq.com/profiling/
- Fleet Automation:     https://docs.datadoghq.com/agent/fleet_automation/
- Workflow Automation:  https://docs.datadoghq.com/service_management/workflows/
- App Builder:          https://docs.datadoghq.com/service_management/app_builder/
- Bits AI:              https://docs.datadoghq.com/bits_ai/

CRITICAL RULES:
1. NEVER construct a sub-path unless you are certain it exists. When in doubt, \
   use the category root URL above — a working root link is far better than a \
   broken deep link.
2. Do NOT invent paths based on feature names. \
   WRONG: https://docs.datadoghq.com/service_management/status_page/ \
   RIGHT: https://docs.datadoghq.com/incident_response/status_pages/ \
   WRONG: https://docs.datadoghq.com/apm/trace_retention/ \
   RIGHT: https://docs.datadoghq.com/tracing/ (use root when unsure of sub-path)
3. Return an empty string if there is no matching category above — do NOT \
   fabricate a URL to fill the field.

---

OUTPUT: Respond with ONLY a valid JSON array. One object per release note, covering all releases:
[
  {
    "index": <integer matching [N] in input>,
    "relevance_score": <1-10>,
    "category": "<category>",
    "docs_link": "<https://docs.datadoghq.com/... or empty string>",
    "why_it_matters": "<2-3 sentences, cause→effect, specific to this customer>",
    "talk_track": "<1-2 sentences starting with Given/Since, conversational>"
  },
  ...
]

Releases scoring ≤4 should still appear in the array. For low-scoring releases, write \
why_it_matters as a brief neutral description of what the feature does (1 sentence, no \
customer context forced in). Do NOT write "No meaningful hook" or similar — that is \
internal language. Example: "Adds AND/OR/NOT scope logic to notification routing rules."
"""

NEWSLETTER_SYSTEM_PROMPT = """\
You are a senior Sales Engineer writing a customer-facing weekly product update newsletter \
for a specific account. You have the account intelligence and a curated list of scored, \
annotated Datadog release notes.

Your job: write four framing elements that wrap around the individual release entries. \
These should read like they were written by someone who knows this account deeply and has \
had real conversations with the team — not a marketing blast.

---

HEADLINE RULES:
- Format: "Your Datadog Update: [hook]"
- The hook MUST name ONE specific business problem or opportunity — do not try to cover everything.
- Maximum 60 characters for the entire headline (including "Your Datadog Update: ").
- It should read like a compelling email subject line someone would actually open.
- Pick the SINGLE most important thread from the featured releases, not a summary of all of them.
  ✓ "Your Datadog Update: Closing the Off-Hours Detection Gap"   (52 chars ✓)
  ✓ "Your Datadog Update: Unblocking Compliance-Safe Synthetics" (59 chars ✓)
  ✗ "Your Datadog Update: Closing the Off-Hours Detection Gap and Unblocking Compliance-Safe Synthetics" (too long, two topics)
  ✗ "Your Datadog Update: New Features in APM and Synthetics" (generic product names, not a business problem)

INTRO PARAGRAPH RULES (3-4 sentences):
- Open by naming the customer's most pressing strategic context or a theme from recent conversations.
- Briefly frame WHY these specific releases were chosen — reference what you've talked about, \
  not where you learned it.
- This is a weekly newsletter, so set the tone: it's curated, not a generic roundup.
- Do NOT list or name the individual releases — those appear below.
- Tone: collegial, direct, knowledgeable. Trusted advisor, not marketer.
- NEVER reference Slack, internal discussions, internal tools, call note dates, or artifact \
  names. Use "our recent conversations", "what you've shared with us", or simply state the \
  customer's situation as fact. The customer should never see evidence of your internal process.

CLOSING PARAGRAPH RULES (2 sentences maximum):
- Sentence 1: A specific proposal — name the 1-2 releases/products most worth a focused session.
  Reference named people from the account if available.
  Example: "Happy to set up a focused 30-minute session with Chris and Mike on the FIPS-compliant \
  private locations release — it directly addresses the compliance blocker from the Propolis call."
- Sentence 2: A soft, open ask.
  Example: "Just let me know what works on your end and I'll get something on the calendar."
- Do NOT write a third sentence. Two sentences only.

CTA_LINE RULES (one short, punchy sentence):
- This appears as a clickable prompt in the newsletter under each release, inviting the reader \
  to request a demo or learn more about that specific feature.
- It should feel like a natural, low-pressure invitation — not a sales pitch.
- Keep it under 15 words. Use "I" (first person SE voice).
  ✓ "Want to see this in your environment? I can set up a quick demo."
  ✓ "Curious how this maps to your current Puppet setup? Happy to walk through it."
  ✓ "This one's worth a closer look — let me know if you'd like a focused session."
- Write ONE cta_line for the entire newsletter (it will be adapted per release in the UI).

---

Respond with ONLY a valid JSON object:
{
  "headline": "Your Datadog Update: [single specific hook, ≤60 chars total]",
  "intro_paragraph": "3-4 sentences, named context, weekly newsletter tone...",
  "closing_paragraph": "Exactly 2 sentences: specific proposal + soft ask.",
  "cta_line": "One short sentence inviting the reader to request a demo or learn more."
}
"""


# ---------------------------------------------------------------------------
# Main Synthesis Function
# ---------------------------------------------------------------------------

async def synthesize_release_digest(
    company_name: str,
    hypothesis: dict | None,
    call_notes: list[dict],
    demo_plan: dict | None,
    additional_context: str = "",
    max_releases: int = 20,
    min_relevance_score: int = 6,
    slack_summaries: list[dict] | None = None,
) -> dict:
    """Fetch release notes, score against customer intelligence, generate digest."""

    # Step 1: Fetch RSS feed
    release_items = await fetch_release_notes(max_items=max_releases)
    if not release_items:
        return _fallback_digest(company_name, "Failed to fetch release notes from RSS feed.")

    # Step 2: Build rich customer intelligence brief
    customer_intel = _extract_customer_intelligence(
        company_name=company_name,
        hypothesis=hypothesis,
        call_notes=call_notes,
        demo_plan=demo_plan,
        additional_context=additional_context,
        slack_summaries=slack_summaries,
    )

    releases_section = _format_releases_for_scoring(release_items)

    scoring_user_message = (
        f"{customer_intel}\n\n"
        f"---\n\nRELEASE NOTES TO SCORE ({len(release_items)} total):\n\n"
        f"{releases_section}\n\n"
        "Score and annotate every release note above. Respond with ONLY a JSON array."
    )

    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    # Step 3: Score and annotate releases
    try:
        score_response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=6000,
            temperature=0.1,  # lower = more grounded, less hallucinated specifics
            system=SCORER_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": scoring_user_message}],
        )
        scores_raw = _strip_fences(extract_text(score_response))
        scores: list[dict] = json.loads(scores_raw)
    except Exception as exc:
        logger.error("Release scoring failed: %s", exc)
        return _fallback_digest(company_name, f"Release scoring failed: {exc}")

    # Step 4: Build RelevantRelease objects, filter and sort
    scored_releases: list[RelevantRelease] = []
    for score_entry in scores:
        idx = score_entry.get("index", -1)
        if not (0 <= idx < len(release_items)):
            continue
        item = release_items[idx]

        # docs_link: prefer feed-supplied [DOCS] link, then Claude's suggestion
        feed_docs = next(
            (lnk["url"] for lnk in item.feed_links if "docs.datadoghq.com" in lnk["url"]),
            "",
        )
        docs_link = feed_docs or score_entry.get("docs_link", "")

        scored_releases.append(RelevantRelease(
            title=item.title,
            link=item.link,
            docs_link=docs_link,
            feed_links=item.feed_links,
            published=item.published,
            relevance_score=score_entry.get("relevance_score", 0),
            why_it_matters=score_entry.get("why_it_matters", ""),
            talk_track=score_entry.get("talk_track", ""),
            category=score_entry.get("category", "Other"),
        ))

    scored_releases.sort(key=lambda r: r.relevance_score, reverse=True)
    relevant = [r for r in scored_releases if r.relevance_score >= min_relevance_score]
    additional = [r for r in scored_releases if r.relevance_score < min_relevance_score]
    featured = relevant[:3]
    others = relevant[3:]

    # Step 5: Generate newsletter framing — pass full customer intel + scored featured releases
    featured_detail = "\n\n".join(
        f"[{r.category}] {r.title} (score {r.relevance_score}/10)\n"
        f"Why it matters: {r.why_it_matters}\n"
        f"Talk track: {r.talk_track}"
        for r in featured
    )

    newsletter_user_message = (
        f"CUSTOMER: {company_name}\n\n"
        f"{customer_intel}\n\n"
        f"---\n\nFEATURED RELEASES FOR THIS CUSTOMER:\n\n{featured_detail}\n\n"
        f"OTHER RELEVANT RELEASES: {len(others)} additional releases scoring ≥{min_relevance_score}/10.\n"
        f"Total releases reviewed: {len(release_items)}.\n\n"
        "Write the headline, intro paragraph, and closing paragraph. "
        "Respond with ONLY a JSON object."
    )

    try:
        nl_response = await client.messages.create(
            model=settings.claude_model,
            max_tokens=1500,
            temperature=0.3,
            system=NEWSLETTER_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": newsletter_user_message}],
        )
        nl_raw = _strip_fences(extract_text(nl_response))
        nl_data = json.loads(nl_raw)
    except Exception as exc:
        logger.warning("Newsletter framing failed: %s", exc)
        nl_data = {
            "headline": f"Your Datadog Update for {company_name}",
            "intro_paragraph": (
                f"Here are the most relevant recent Datadog releases for {company_name}, "
                "curated based on your current environment and priorities."
            ),
            "closing_paragraph": (
                "Happy to set up time to walk through how any of these fit into your current work. "
                "Just let me know what works on your end."
            ),
            "cta_line": "Interested in seeing this in action? Happy to set up a quick demo.",
        }

    return {
        "company_name": company_name,
        "headline": nl_data.get("headline", ""),
        "intro_paragraph": nl_data.get("intro_paragraph", ""),
        "featured_releases": [r.model_dump() for r in featured],
        "other_relevant_releases": [r.model_dump() for r in others],
        "additional_releases": [r.model_dump() for r in additional],
        "closing_paragraph": nl_data.get("closing_paragraph", ""),
        "cta_line": nl_data.get("cta_line", "Interested in a closer look? Happy to set up a quick demo."),
        "total_releases_reviewed": len(release_items),
        "releases_above_threshold": len(relevant),
    }


def _fallback_digest(company_name: str, error_msg: str) -> dict:
    return {
        "company_name": company_name,
        "headline": f"Datadog Update for {company_name}",
        "intro_paragraph": f"Digest generation encountered an error: {error_msg}",
        "featured_releases": [],
        "other_relevant_releases": [],
        "closing_paragraph": "Please retry or contact your SE for the latest updates.",
        "total_releases_reviewed": 0,
        "releases_above_threshold": 0,
    }
