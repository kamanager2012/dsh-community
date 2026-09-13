# acs_core — Agent Constraint System shared core
# Agent-agnostic guard logic used by all adapter variants.

from .guard import check_bash, DANGEROUS_BASH, GIT_DESTRUCTIVE, clean_command
from .paths import FORBIDDEN_ROOTS, is_forbidden_path, is_self_protect
from .violations import (
    add_violation, clear_violations, window_score, should_lock,
    integrity_store, integrity_verify, load_violations,
)
from .audit import AuditLogger

__all__ = [
    "check_bash",
    "clean_command",
    "FORBIDDEN_ROOTS",
    "is_forbidden_path",
    "is_self_protect",
    "add_violation",
    "clear_violations",
    "window_score",
    "should_lock",
    "load_violations",
    "integrity_store",
    "integrity_verify",
    "AuditLogger",
]
