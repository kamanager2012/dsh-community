# acs_core/capability_ledger.py -- Capability Preservation Ledger
#
# Tracks hardcoded credentials the running code depends on, so an agent cannot
# delete/clear/relocate them before a verified replacement is in place.
# Shares persistence machinery with AssetLedger via KeyedJsonLedger, and gates
# its state machine like VerifiedCopyProtocol (verification gate).
#
# State machine (strict, ±1 transitions only — see _TRANSITIONS):
#   ACTIVE_HARDCODED_SECRET
#       │  (replacement source configured, e.g. env var detected)
#       ▼
#   REPLACEMENT_CONFIGURED
#       │  (replacement credential loads + authenticates)
#       ▼
#   REPLACEMENT_VERIFIED
#       │  (a dependent workflow smoke-test passes using the new source)
#       ▼
#   DEPENDENT_WORKFLOW_PASSED
#       │  (old credential no longer referenced by any code path)
#       ▼
#   OLD_SECRET_REMOVABLE   ──> delete/clear/relocate ALLOWed
#
# Transition rules:
#   - A mark_* may only advance from the documented previous state (idempotent
#     re-calls on the same state are allowed). Any jump (e.g. track() then
#     mark_removable()) raises ValueError — a credential must never become
#     removable without the full verification chain.
#
# Decision gate (removal_decision):
#   ACTIVE_HARDCODED_SECRET / REPLACEMENT_CONFIGURED → BLOCK
#   REPLACEMENT_VERIFIED                              → CONFIRM (no smoke test yet)
#   DEPENDENT_WORKFLOW_PASSED / OLD_SECRET_REMOVABLE → ALLOW

import time
from typing import Dict, List, Optional
from dataclasses import dataclass, field, asdict

from ledger_base import KeyedJsonLedger


@dataclass
class CapabilityEntry:
    """A single tracked credential's lifecycle record."""
    path: str
    secret_id: str                                   # e.g. "OPENAI_API_KEY"
    state: str = "ACTIVE_HARDCODED_SECRET"
    replacement_source: Optional[str] = None         # e.g. "env:OPENAI_API_KEY"
    verified_at: Optional[float] = None              # timestamp of REPLACEMENT_VERIFIED
    smoke_test: Optional[str] = None                 # command run at DEPENDENT_WORKFLOW_PASSED
    dependents: List[str] = field(default_factory=list)  # code paths referencing this secret
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict:
        return asdict(self)


# Documented ±1 transitions: target state -> its only legal previous state.
# Enforcement lives in CapabilityLedger._advance; a state not listed here has
# no reachable predecessor and can only be entered via the listed transition.
_TRANSITIONS = {
    "REPLACEMENT_CONFIGURED": "ACTIVE_HARDCODED_SECRET",
    "REPLACEMENT_VERIFIED": "REPLACEMENT_CONFIGURED",
    "DEPENDENT_WORKFLOW_PASSED": "REPLACEMENT_VERIFIED",
    "OLD_SECRET_REMOVABLE": "DEPENDENT_WORKFLOW_PASSED",
}


class CapabilityLedger(KeyedJsonLedger[CapabilityEntry]):
    """Tracks hardcoded credentials so their removal is gated on a verified
    replacement, preventing silent runtime capability loss.

    Usage:
        ledger = CapabilityLedger()
        ledger.track(".env", secret_id="OPENAI_API_KEY", dependents=["src/api.py"])
        ledger.removal_decision(".env")   # -> "BLOCK: credential_dependency_unsatisfied"
        ledger.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
        ledger.mark_replacement_verified(".env")
        ledger.mark_workflow_passed(".env", "pytest tests/test_api.py")
        ledger.mark_removable(".env")
        ledger.removal_decision(".env")   # -> "ALLOW: ..."
    """

    _entry_type = CapabilityEntry

    @property
    def _caps(self) -> Dict[str, CapabilityEntry]:
        """Back-compat alias: older code reads ledger._caps."""
        return self._entries

    # -- Tracking --

    def track(self, path: str, secret_id: str, dependents: Optional[List[str]] = None) -> CapabilityEntry:
        """Register a hardcoded credential the code depends on."""
        return self._track(
            path,
            secret_id=secret_id,
            dependents=list(dependents) if dependents else [],
        )

    # -- State machine transitions --

    def _advance(self, path: str, target: str) -> CapabilityEntry:
        """Advance an entry to ``target``, enforcing the ±1 transition table.

        Raises ValueError on a state jump (e.g. track() then mark_removable()
        without the verification chain in between). Re-calling the transition
        that produced the current state is idempotent.
        """
        entry = self._require(path)
        previous = _TRANSITIONS[target]
        if entry.state not in (previous, target):
            raise ValueError(
                f"capability state jump: {entry.state} -> {target} "
                f"(legal previous state: {previous}); "
                "credentials are only removable after the full "
                "configure -> verified -> workflow-passed chain"
            )
        entry.state = target
        return entry

    def mark_replacement_configured(self, path: str, replacement_source: str) -> CapabilityEntry:
        """Replacement source configured (e.g. env var detected). Still BLOCK —
        replacement not yet proven to load/authenticate."""
        entry = self._advance(path, "REPLACEMENT_CONFIGURED")
        entry.replacement_source = replacement_source
        entry.updated_at = time.time()
        self._save()
        return entry

    def mark_replacement_verified(self, path: str) -> CapabilityEntry:
        """Replacement credential loads + authenticates. Drops to CONFIRM — a
        dependent workflow smoke-test is still required before removal."""
        entry = self._advance(path, "REPLACEMENT_VERIFIED")
        entry.verified_at = time.time()
        entry.updated_at = time.time()
        self._save()
        return entry

    def mark_workflow_passed(self, path: str, smoke_test: str) -> CapabilityEntry:
        """A dependent workflow smoke-test passed using the new source."""
        entry = self._advance(path, "DEPENDENT_WORKFLOW_PASSED")
        entry.smoke_test = smoke_test
        entry.updated_at = time.time()
        self._save()
        return entry

    def mark_removable(self, path: str) -> CapabilityEntry:
        """Old credential no longer referenced by any code path — safe to remove."""
        entry = self._advance(path, "OLD_SECRET_REMOVABLE")
        entry.updated_at = time.time()
        self._save()
        return entry

    # -- Queries --

    def removal_decision(self, path: str) -> str:
        """Check whether a depended-on credential may be removed.

        Returns one of:
            "ALLOW"                          -- untracked, or replacement fully verified
            "CONFIRM: ..."                   -- needs human confirmation
            "BLOCK: ..."                     -- removal would break runtime capability
        """
        entry = self.get(path)
        if entry is None:
            return "ALLOW"  # not a tracked credential — not our concern

        if entry.state in ("ACTIVE_HARDCODED_SECRET", "REPLACEMENT_CONFIGURED"):
            return "BLOCK: credential_dependency_unsatisfied"
        if entry.state == "REPLACEMENT_VERIFIED":
            return "CONFIRM: replacement_verified_pending_smoke_test"
        # DEPENDENT_WORKFLOW_PASSED or OLD_SECRET_REMOVABLE
        return "ALLOW: replacement_verified_workflow_passed"
