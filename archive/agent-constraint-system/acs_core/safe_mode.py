# acs_core/safe_mode.py -- Post-Error Safe Mode (with persistence)
import json, os, tempfile, time
from typing import Dict


class SafeMode:
    """Post-Error Safe Mode with cross-process persistence.

    Stores state in safe_mode.json so error counts survive
    across hook process invocations.

    Usage:
        sm = SafeMode("/path/to/safe_mode.json")
        sm.record_error("moved user files to /tmp")
        sm.is_active()  # True after threshold errors
    """

    def __init__(self, storage_path: str = None, threshold: int = 2, window_seconds: int = 3600):
        self._storage_path = storage_path
        self._errors: list[float] = []
        self.threshold = threshold
        self.window_seconds = window_seconds
        if storage_path:
            self._load()

    def record_error(self, description: str = "") -> None:
        self._load()  # reload from disk to get cross-process state
        self._errors.append(time.time())
        self._save()

    def error_count(self) -> int:
        self._load()
        now = time.time()
        cutoff = now - self.window_seconds
        self._errors = [t for t in self._errors if t > cutoff]
        return len(self._errors)

    def is_active(self) -> bool:
        return self.error_count() >= self.threshold

    def reset(self) -> None:
        self._errors = []
        self._save()

    def to_dict(self) -> Dict:
        # Compute from in-memory state only (no _load() recursion into _save)
        now = time.time()
        cutoff = now - self.window_seconds
        recent = [t for t in self._errors if t > cutoff]
        return {
            "errors": self._errors,
            "threshold": self.threshold,
            "window_seconds": self.window_seconds,
            "active": len(recent) >= self.threshold,
            "count": len(recent),
        }

    def _save(self) -> None:
        if not self._storage_path:
            return
        os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
        # Atomic write via mkstemp + replace. A FIXED ".tmp" name races: two
        # hook processes writing concurrently truncate each other's tmp file
        # and the loser's os.replace() raises FileNotFoundError (its fd points
        # at a renamed-away inode), crashing the hook.
        fd, tmp_path = tempfile.mkstemp(
            dir=os.path.dirname(self._storage_path) or ".",
            prefix=".tmp_", suffix=".json",
        )
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(self.to_dict(), f, indent=2)
            os.replace(tmp_path, self._storage_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _load(self) -> None:
        if not self._storage_path or not os.path.exists(self._storage_path):
            return
        try:
            with open(self._storage_path) as f:
                data = json.load(f)
            self._errors = data.get("errors", [])
            self.threshold = data.get("threshold", self.threshold)
            self.window_seconds = data.get("window_seconds", self.window_seconds)
        except (json.JSONDecodeError, FileNotFoundError):
            pass
