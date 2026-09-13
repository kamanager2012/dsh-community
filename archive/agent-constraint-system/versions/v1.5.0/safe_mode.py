# acs_core/safe_mode.py -- Post-Error Safe Mode
#
# Elevates risk thresholds after consecutive agent errors.
# When safe_mode is active, all destructive operations require
# human confirmation (CONFIRM instead of ALLOW).
#
# Used by: check_bash_with_context() in guard.py

import time
from typing import Dict, Optional


class SafeMode:
    """Post-Error Safe Mode controller.

    Usage:
        sm = SafeMode()

        # Agent makes a mistake
        sm.record_error("moved user files to /tmp")

        # Agent makes another mistake
        sm.record_error("attempted to delete recovered assets")

        # Now safe mode is active (2 errors in 1 hour)
        sm.is_active()  # -> True

        # Destructive operations require CONFIRM
        # After 1 hour of error-free operation, auto-resets
    """

    def __init__(self, threshold: int = 2, window_seconds: int = 3600):
        self._errors: list[float] = []  # timestamps of errors
        self.threshold = threshold
        self.window_seconds = window_seconds

    def record_error(self, description: str = "") -> None:
        """Record an agent error."""
        self._errors.append(time.time())

    def error_count(self) -> int:
        """Count errors within the current window."""
        now = time.time()
        cutoff = now - self.window_seconds
        self._errors = [t for t in self._errors if t > cutoff]
        return len(self._errors)

    def is_active(self) -> bool:
        """Check if safe mode should be active."""
        return self.error_count() >= self.threshold

    def reset(self) -> None:
        """Reset safe mode (after user confirmation)."""
        self._errors.clear()

    def to_dict(self) -> Dict:
        return {
            "errors": self._errors,
            "threshold": self.threshold,
            "window_seconds": self.window_seconds,
            "active": self.is_active(),
            "count": self.error_count(),
        }
