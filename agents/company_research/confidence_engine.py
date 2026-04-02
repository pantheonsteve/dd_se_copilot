"""Technology Confidence Engine — cross-references Sumble + BuiltWith signals.

The engine is pure deterministic logic: no LLM calls, no network.  It receives
pre-collected technology signals from multiple sources and classifies every
detected technology into one of three confidence tiers.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from enum import Enum

from pydantic import BaseModel, Field

from builtwith_client import BuiltWithResult
from tech_normalizer import (
    COMPETITIVE_TOOLS,
    TECH_CATEGORIES,
    TECH_DEPENDENCIES,
    categorize_tech,
    normalize_tech_name,
)

# ---------------------------------------------------------------------------
# Enums & Models
# ---------------------------------------------------------------------------

_CATEGORY_TO_FLAT_KEY: dict[str, str] = {
    "observability": "observability",
    "cloud": "cloud",
    "infra": "infra",
    "security": "security",
    "databases": "databases",
    "message_queues": "message_queues",
    "languages": "languages",
    "data_platforms": "data_platforms",
    "cicd": "cicd",
    "feature_flags": "feature_flags",
    "serverless": "serverless",
    "networking": "networking",
}

_RECENT_JOB_DAYS = 90
_STRONG_SIGNAL_THRESHOLD = 3


class ConfidenceTier(str, Enum):
    CONFIRMED = "confirmed"
    LIKELY = "likely"
    UNVERIFIED = "unverified"


class TechnologySignal(BaseModel):
    """A single detection of a technology from one source."""
    source: str
    raw_name: str
    canonical_name: str
    detection_context: str | None = None
    detection_date: datetime | None = None
    source_count: int = 1


class ClassifiedTechnology(BaseModel):
    """A technology with its confidence classification."""
    canonical_name: str
    confidence: ConfidenceTier
    signals: list[TechnologySignal] = Field(default_factory=list)
    signal_strength: int = 0
    source_names: list[str] = Field(default_factory=list)
    category: str | None = None
    is_competitive_target: bool = False
    confidence_rationale: str = ""


class TechnologyLandscape(BaseModel):
    """Complete classified technology landscape for a company."""
    domain: str = ""
    technologies: list[ClassifiedTechnology] = Field(default_factory=list)

    @property
    def confirmed(self) -> list[ClassifiedTechnology]:
        return [t for t in self.technologies if t.confidence == ConfidenceTier.CONFIRMED]

    @property
    def likely(self) -> list[ClassifiedTechnology]:
        return [t for t in self.technologies if t.confidence == ConfidenceTier.LIKELY]

    @property
    def unverified(self) -> list[ClassifiedTechnology]:
        return [t for t in self.technologies if t.confidence == ConfidenceTier.UNVERIFIED]

    @property
    def competitive_targets(self) -> list[ClassifiedTechnology]:
        return [t for t in self.technologies if t.is_competitive_target]

    @property
    def confidence_summary(self) -> dict:
        return {
            "confirmed": len(self.confirmed),
            "likely": len(self.likely),
            "unverified": len(self.unverified),
            "total": len(self.technologies),
            "sources_used": sorted(set(s for t in self.technologies for s in t.source_names)),
        }

    def to_flat_buckets(self) -> dict[str, list[str]]:
        """Rebuild the 11 flat category lists for backward compatibility."""
        buckets: dict[str, list[str]] = {k: [] for k in _CATEGORY_TO_FLAT_KEY.values()}
        for tech in self.technologies:
            key = _CATEGORY_TO_FLAT_KEY.get(tech.category or "")
            if key and tech.canonical_name not in buckets[key]:
                buckets[key].append(tech.canonical_name)
        return buckets


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

class ConfidenceEngine:
    """Cross-references multiple data sources to classify technology confidence."""

    def classify(
        self,
        sumble_signals: list[TechnologySignal],
        builtwith_result: BuiltWithResult | None,
    ) -> TechnologyLandscape:
        """Main classification entry point.

        Parameters
        ----------
        sumble_signals:
            Pre-built signal objects from Sumble (enrich + jobs + people).
        builtwith_result:
            Parsed BuiltWith lookup result (may be None if API unavailable).
        """
        # Step 1: collect all signals into a unified list
        all_signals: list[TechnologySignal] = list(sumble_signals)
        all_signals.extend(self._builtwith_signals(builtwith_result))

        # Step 2: group by canonical name
        grouped: dict[str, list[TechnologySignal]] = defaultdict(list)
        for sig in all_signals:
            grouped[sig.canonical_name].append(sig)

        # Step 3 + 5: classify each technology
        classified: dict[str, ClassifiedTechnology] = {}
        for canonical, signals in grouped.items():
            tier, rationale = self._apply_rules(canonical, signals)
            category = categorize_tech(canonical)
            is_competitive = canonical in COMPETITIVE_TOOLS
            distinct_sources = sorted(set(s.source for s in signals))
            total_strength = sum(s.source_count for s in signals)

            classified[canonical] = ClassifiedTechnology(
                canonical_name=canonical,
                confidence=tier,
                signals=signals,
                signal_strength=total_strength,
                source_names=distinct_sources,
                category=category,
                is_competitive_target=is_competitive,
                confidence_rationale=rationale,
            )

        # Step 4: dependency inference
        self._apply_dependency_inference(classified)

        domain = builtwith_result.domain if builtwith_result else ""

        # Sort: confirmed first, then likely, then unverified; within tier by strength desc
        tier_order = {ConfidenceTier.CONFIRMED: 0, ConfidenceTier.LIKELY: 1, ConfidenceTier.UNVERIFIED: 2}
        techs = sorted(
            classified.values(),
            key=lambda t: (tier_order.get(t.confidence, 9), -t.signal_strength),
        )

        return TechnologyLandscape(domain=domain, technologies=techs)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _builtwith_signals(bw: BuiltWithResult | None) -> list[TechnologySignal]:
        if not bw:
            return []
        signals: list[TechnologySignal] = []
        for tech in bw.technologies:
            canonical = normalize_tech_name(tech.name)
            context_parts = [f"live on {bw.domain}"]
            if tech.subdomain:
                context_parts.append(f"subdomain: {tech.subdomain}")
            signals.append(TechnologySignal(
                source="builtwith",
                raw_name=tech.name,
                canonical_name=canonical,
                detection_context=", ".join(context_parts),
                detection_date=tech.last_detected,
                source_count=1,
            ))
        return signals

    @staticmethod
    def _apply_rules(
        canonical: str,
        signals: list[TechnologySignal],
    ) -> tuple[ConfidenceTier, str]:
        distinct_sources = set(s.source for s in signals)
        has_builtwith = "builtwith" in distinct_sources
        builtwith_live = any(
            s.source == "builtwith" and s.detection_context and "live on" in s.detection_context
            for s in signals
        )

        # Rule 1: 2+ independent sources -> CONFIRMED
        if len(distinct_sources) >= 2:
            parts = []
            for src in sorted(distinct_sources):
                src_signals = [s for s in signals if s.source == src]
                total = sum(s.source_count for s in src_signals)
                ctx = src_signals[0].detection_context or ""
                if "sumble" in src:
                    parts.append(f"{src.replace('_', ' ').title()} ({total} mention{'s' if total != 1 else ''})")
                else:
                    parts.append(f"BuiltWith ({ctx})")
            return ConfidenceTier.CONFIRMED, f"Confirmed: Detected by {' and '.join(parts)}"

        # Rule 2: BuiltWith live detection (single source but direct evidence)
        if builtwith_live:
            bw_sig = next(s for s in signals if s.source == "builtwith")
            return ConfidenceTier.CONFIRMED, f"Confirmed: BuiltWith live detection ({bw_sig.detection_context})"

        # Single source remaining
        total_count = sum(s.source_count for s in signals)
        source_name = next(iter(distinct_sources))

        # Check for recent job post
        now = datetime.now(timezone.utc)
        has_recent = any(
            s.detection_date and (now - s.detection_date) < timedelta(days=_RECENT_JOB_DAYS)
            for s in signals
        )

        # Rule 3: strong single-source signal -> LIKELY
        if total_count >= _STRONG_SIGNAL_THRESHOLD:
            return (
                ConfidenceTier.LIKELY,
                f"Likely: Detected by {source_name.replace('_', ' ').title()} "
                f"({total_count} mention{'s' if total_count != 1 else ''})",
            )

        if has_recent:
            return (
                ConfidenceTier.LIKELY,
                f"Likely: Detected by {source_name.replace('_', ' ').title()} "
                f"(recent job post within {_RECENT_JOB_DAYS} days)",
            )

        # Rule 4: BuiltWith subdomain-only or old last_detected
        if has_builtwith and not builtwith_live:
            return (
                ConfidenceTier.UNVERIFIED,
                "Unverified: BuiltWith detected on subdomain or with stale data",
            )

        # Rule 5: weak single source -> UNVERIFIED
        return (
            ConfidenceTier.UNVERIFIED,
            f"Unverified: Single mention in {source_name.replace('_', ' ').title()} "
            f"({total_count} signal{'s' if total_count != 1 else ''}, may be stale)",
        )

    @staticmethod
    def _apply_dependency_inference(classified: dict[str, ClassifiedTechnology]) -> None:
        """Upgrade technologies implied by confirmed parents."""
        for parent_name, dependents in TECH_DEPENDENCIES.items():
            parent = classified.get(parent_name)
            if not parent or parent.confidence != ConfidenceTier.CONFIRMED:
                continue
            for dep_name in dependents:
                if dep_name in classified:
                    dep = classified[dep_name]
                    if dep.confidence == ConfidenceTier.UNVERIFIED:
                        dep.confidence = ConfidenceTier.LIKELY
                        dep.confidence_rationale = (
                            f"Likely: Inferred from confirmed dependency — "
                            f"{parent_name} implies {dep_name}"
                        )
                else:
                    category = categorize_tech(dep_name)
                    classified[dep_name] = ClassifiedTechnology(
                        canonical_name=dep_name,
                        confidence=ConfidenceTier.LIKELY,
                        signals=[],
                        signal_strength=0,
                        source_names=[],
                        category=category,
                        is_competitive_target=dep_name in COMPETITIVE_TOOLS,
                        confidence_rationale=(
                            f"Likely: Inferred from confirmed dependency — "
                            f"{parent_name} implies {dep_name}"
                        ),
                    )
