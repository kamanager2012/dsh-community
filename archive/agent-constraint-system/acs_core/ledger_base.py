# acs_core/ledger_base.py -- Shared JSON persistence for ACS ledgers
#
# Both AssetLedger and CapabilityLedger persist a {path: entry-dataclass} map
# to a JSON file. This base class owns that machinery once:
#   - atomic writes (mkstemp + os.replace)
#   - cross-process safety (flock-guarded save that merges on-disk state, so
#     two hook processes writing concurrently cannot lose each other's
#     entries or clobber a shared .tmp filename)
#   - forward-tolerant loading (unknown JSON fields are dropped, missing
#     fields get dataclass defaults)
#
# Subclass contract:
#   - class attribute ``_entry_type``: the entry dataclass type
#   - ``_make_entry(path, **kw)``: construct a new entry (defaults to
#     ``_entry_type(path=path, **kw)``)

import fcntl
import json
import os
import tempfile
import time
from dataclasses import fields
from pathlib import Path
from typing import Any, Dict, Generic, Optional, Set, Type, TypeVar

T = TypeVar("T")


class KeyedJsonLedger(Generic[T]):
    """Persist a {path: entry-dataclass} map to a JSON file.

    All mutating operations persist immediately; _save() takes an exclusive
    flock on ``<storage_path>.lock``, re-merges on-disk state (disk-only
    entries are kept, in-memory wins for the same key — last writer wins),
    and atomically replaces the JSON file.

    Deletions use a process-local tombstone (``untrack``): the merged on-disk
    state must not resurrect a key this process just removed.
    """

    _entry_type: Type[T] = None  # type: ignore[assignment]  # set by subclasses

    def __init__(self, storage_path: Optional[str] = None):
        self._entries: Dict[str, T] = {}
        self._deleted: Set[str] = set()  # tombstone: keys removed by untrack
        self._storage_path = storage_path
        if storage_path and os.path.exists(storage_path):
            self._load()

    # -- Core operations --

    def get(self, path: str) -> Optional[T]:
        """Get the entry for a path, or None if untracked."""
        resolved = str(Path(path).resolve())
        return self._entries.get(resolved)

    def is_tracked(self, path: str) -> bool:
        return self.get(path) is not None

    def untrack(self, path: str) -> None:
        """Remove a path from the ledger (after verified safe deletion)."""
        resolved = str(Path(path).resolve())
        self._entries.pop(resolved, None)
        # Tombstone so the save-time merge does not resurrect the key from
        # on-disk state written by a concurrent process.
        self._deleted.add(resolved)
        try:
            self._save()
        finally:
            self._deleted.clear()

    def clear(self) -> None:
        """Clear all ledger entries."""
        self._entries.clear()
        if self._storage_path and os.path.exists(self._storage_path):
            os.remove(self._storage_path)

    # -- Entry construction --

    def _entry_from_raw(self, raw: Dict[str, Any]) -> T:
        """Build an entry from a raw JSON dict, dropping unknown fields
        (forward compatibility) and letting missing fields fall back to
        dataclass defaults."""
        known = {f.name for f in fields(self._entry_type)}
        clean = {name: val for name, val in raw.items() if name in known}
        return self._entry_type(**clean)

    def _make_entry(self, path: str, **kw: Any) -> T:
        return self._entry_type(path=path, **kw)

    def _track(self, path: str, **kw: Any) -> T:
        """Register a path. Existing entries only get their timestamp bumped
        (no re-save); new entries are persisted immediately."""
        resolved = str(Path(path).resolve())
        if resolved in self._entries:
            entry = self._entries[resolved]
            entry.updated_at = time.time()
            return entry
        entry = self._make_entry(resolved, **kw)
        self._entries[resolved] = entry
        self._save()
        return entry

    def _require(self, path: str) -> T:
        """Get a tracked entry or raise KeyError (for state transitions)."""
        resolved = str(Path(path).resolve())
        entry = self._entries.get(resolved)
        if entry is None:
            raise KeyError(f"path not tracked: {path}")
        return entry

    # -- I/O --

    def _load_raw(self, path: Path) -> Optional[Dict[str, Any]]:
        """Load the raw JSON map, or None on any failure."""
        try:
            with open(path) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return None
        return data if isinstance(data, dict) else None

    def _load(self) -> None:
        """Load entries, tolerating unknown fields (forward compatibility):
        unknown JSON keys are dropped, missing keys fall back to dataclass
        defaults — a ledger written by a newer version must not crash the
        older one (crash would make every tracked asset "untracked")."""
        data = self._load_raw(Path(self._storage_path))
        if data is None:
            return
        for k, v in data.items():
            if not isinstance(v, dict):
                continue
            self._entries[k] = self._entry_from_raw(v)

    def _save(self) -> None:
        if not self._storage_path:
            return
        path = Path(self._storage_path)
        path.parent.mkdir(parents=True, exist_ok=True)

        lock_path = str(path) + ".lock"
        with open(lock_path, "w") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            try:
                # Merge with on-disk state so a concurrent writer in another
                # process doesn't lose entries: disk-only keys are kept (raw
                # dicts rehydrated into entries), in-memory versions win for
                # the same key (last writer wins). Tombstoned keys (this
                # process's untrack) are never resurrected.
                disk = self._load_raw(path)
                if disk is not None:
                    merged: Dict[str, T] = dict(self._entries)
                    for k, raw in disk.items():
                        if k not in merged and k not in self._deleted and isinstance(raw, dict):
                            merged[k] = self._entry_from_raw(raw)
                    self._entries = merged
                data = {k: v.to_dict() for k, v in self._entries.items()}
                fd, tmp_path = tempfile.mkstemp(
                    dir=str(path.parent) or ".", prefix=".tmp_", suffix=".json"
                )
                try:
                    with os.fdopen(fd, "w") as f:
                        json.dump(data, f, indent=2)
                    os.replace(tmp_path, str(path))
                finally:
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
            finally:
                fcntl.flock(lf, fcntl.LOCK_UN)
