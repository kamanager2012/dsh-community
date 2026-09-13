# acs_core/asset_ledger.py -- Asset provenance and lifecycle tracking
#
# Tracks files and directories through their lifecycle so ACS can make
# context-aware safety decisions, not just pattern-match commands.
#
# Asset Lifecycle:
#   UNTRACKED -> RECOVERED -> MOVED -> VERIFIED -> SAFE_TO_DELETE
#                                         |
#                                   BACKED_UP
#
# Risk Levels:
#   CRITICAL  -- recovered asset, no verified copy, no backup -> BLOCK delete
#   HIGH      -- moved asset, unverified -> CONFIRM delete
#   MEDIUM    -- tracked but authorized -> ALLOW with audit
#   LOW       -- untracked temp -> ALLOW

import json
import os
import time
from pathlib import Path
from typing import Dict, List, Optional
from dataclasses import dataclass, field, asdict


@dataclass
class AssetEntry:
    """A single asset's lifecycle record."""
    path: str
    origin: str = "unknown"            # recovered_from_history, user_created, agent_generated
    status: str = "UNTRACKED"          # UNTRACKED, RECOVERED, MOVED, VERIFIED, BACKED_UP
    moved_from: Optional[str] = None   # previous location if moved
    moved_to: Optional[str] = None     # current location if moved
    verified_copy: bool = False         # has been verified at destination
    backup_location: Optional[str] = None
    delete_authorized: bool = False    # user explicitly authorized deletion
    agent_error_count: int = 0         # consecutive errors involving this asset
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict:
        return asdict(self)


class AssetLedger:
    """Tracks asset provenance and lifecycle for context-aware safety decisions.

    Usage:
        ledger = AssetLedger()
        ledger.track("/tmp/dramatools", origin="recovered_from_history")
        ledger.move("/tmp/dramatools", from_dir="/project", to_dir="/tmp")
        # ... later ...
        ledger.is_safe_to_delete("/tmp/dramatools")  # -> "BLOCK: critical_asset_no_copy"
    """

    def __init__(self, storage_path: Optional[str] = None):
        self._assets: Dict[str, AssetEntry] = {}
        self._storage_path = storage_path
        if storage_path and os.path.exists(storage_path):
            self._load()

    # -- Tracking --

    def track(self, path: str, origin: str = "unknown") -> AssetEntry:
        """Register a path in the ledger."""
        resolved = str(Path(path).resolve())
        if resolved in self._assets:
            entry = self._assets[resolved]
            entry.updated_at = time.time()
            return entry
        entry = AssetEntry(path=resolved, origin=origin, status="RECOVERED")
        self._assets[resolved] = entry
        self._save()
        return entry

    def untrack(self, path: str) -> None:
        """Remove a path from the ledger (after verified safe deletion)."""
        resolved = str(Path(path).resolve())
        self._assets.pop(resolved, None)
        self._save()

    # -- Movement --

    def move(self, path: str, from_dir: str, to_dir: str) -> AssetEntry:
        """Record a file/directory move. Updates the entry to track provenance."""
        resolved = str(Path(path).resolve())
        entry = self._get_or_create(resolved)
        entry.moved_from = str(Path(from_dir).resolve())
        entry.moved_to = str(Path(to_dir).resolve())
        entry.status = "MOVED"
        entry.verified_copy = False
        entry.updated_at = time.time()
        self._save()
        return entry

    def mark_verified(self, path: str) -> AssetEntry:
        """Mark that a copy has been verified at the destination."""
        resolved = str(Path(path).resolve())
        entry = self._get_or_create(resolved)
        entry.verified_copy = True
        entry.status = "VERIFIED"
        entry.updated_at = time.time()
        self._save()
        return entry

    # -- Backup --

    def mark_backup(self, path: str, backup_location: str) -> AssetEntry:
        """Record a backup location for the asset."""
        resolved = str(Path(path).resolve())
        entry = self._get_or_create(resolved)
        entry.backup_location = str(Path(backup_location).resolve())
        entry.status = "BACKED_UP"
        entry.updated_at = time.time()
        self._save()
        return entry

    # -- Authorization --

    def authorize_delete(self, path: str) -> AssetEntry:
        """User explicitly authorizes deletion of this asset."""
        resolved = str(Path(path).resolve())
        entry = self._get_or_create(resolved)
        entry.delete_authorized = True
        entry.updated_at = time.time()
        self._save()
        return entry

    # -- Error tracking --

    def record_error(self, path: str) -> AssetEntry:
        """Record that the agent made an error involving this asset."""
        resolved = str(Path(path).resolve())
        entry = self._get_or_create(resolved)
        entry.agent_error_count += 1
        entry.updated_at = time.time()
        self._save()
        return entry

    # -- Safety checks --

    def get(self, path: str) -> Optional[AssetEntry]:
        """Get the ledger entry for a path, or None if untracked."""
        resolved = str(Path(path).resolve())
        return self._assets.get(resolved)

    def is_tracked(self, path: str) -> bool:
        """Check if a path is in the ledger."""
        return self.get(path) is not None

    def is_safe_to_delete(self, path: str) -> str:
        """Check if it's safe to delete this path.

        Returns one of:
            "ALLOW"     -- safe to delete (untracked temp, or authorized + verified)
            "CONFIRM"   -- needs human confirmation (moved but unverified, no backup)
            "BLOCK"     -- dangerous (critical asset, no copy, no backup, not authorized)
        """
        entry = self.get(path)

        # Not tracked: assume safe (untracked temp files)
        if entry is None:
            return "ALLOW"

        # Explicitly authorized + verified copy exists: safe
        if entry.delete_authorized and entry.verified_copy:
            entry.status = "SAFE_TO_DELETE"
            entry.updated_at = time.time()
            self._save()
            return "ALLOW"

        # Authorized but no verified copy: confirm
        if entry.delete_authorized and not entry.verified_copy:
            return "CONFIRM: authorized but no verified copy"

        # Critical asset: recovered from history, no copy, no backup, not authorized
        if entry.origin == "recovered_from_history" and not entry.verified_copy and not entry.backup_location:
            return "BLOCK: critical_asset_no_copy_no_backup"

        # Has backup: confirm
        if entry.backup_location and not entry.verified_copy:
            return "CONFIRM: backup exists but copy not verified"

        # Moved asset, unverified: confirm
        if entry.status == "MOVED" and not entry.verified_copy:
            return "CONFIRM: moved_asset_unverified"

        # Authorized: allow
        if entry.delete_authorized:
            return "ALLOW: authorized"

        # Default: confirm for any tracked asset
        return "CONFIRM: tracked_asset"

    def is_error_prone(self, path: str, threshold: int = 2) -> bool:
        """Check if agent has made repeated errors with this asset."""
        entry = self.get(path)
        if entry and entry.agent_error_count >= threshold:
            return True
        return False

    # -- I/O --

    def _get_or_create(self, resolved: str) -> AssetEntry:
        if resolved in self._assets:
            return self._assets[resolved]
        entry = AssetEntry(path=resolved)
        self._assets[resolved] = entry
        return entry

    def _save(self) -> None:
        if self._storage_path:
            data = {k: v.to_dict() for k, v in self._assets.items()}
            os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
            with open(self._storage_path, 'w') as f:
                json.dump(data, f, indent=2)

    def _load(self) -> None:
        try:
            with open(self._storage_path) as f:
                data = json.load(f)
            for k, v in data.items():
                self._assets[k] = AssetEntry(**v)
        except (json.JSONDecodeError, FileNotFoundError):
            pass

    def clear(self) -> None:
        """Clear all ledger entries."""
        self._assets.clear()
        if self._storage_path and os.path.exists(self._storage_path):
            os.remove(self._storage_path)
