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
#
# Persistence is inherited from KeyedJsonLedger (atomic + flock-guarded save,
# forward-tolerant load).

import time
from typing import Dict, Optional
from dataclasses import dataclass, field, asdict
from pathlib import Path

from ledger_base import KeyedJsonLedger


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


class AssetLedger(KeyedJsonLedger[AssetEntry]):
    """Tracks asset provenance and lifecycle for context-aware safety decisions.

    Usage:
        ledger = AssetLedger()
        ledger.track("/tmp/dramatools", origin="recovered_from_history")
        ledger.move("/tmp/dramatools", from_dir="/project", to_dir="/tmp")
        # ... later ...
        ledger.is_safe_to_delete("/tmp/dramatools")  # -> "BLOCK: critical_asset_no_copy"
    """

    _entry_type = AssetEntry

    @property
    def _assets(self) -> Dict[str, AssetEntry]:
        """Back-compat alias: older code (tests, adapters) reads ledger._assets."""
        return self._entries

    # -- Tracking --

    def track(self, path: str, origin: str = "unknown") -> AssetEntry:
        """Register a path in the ledger."""
        return self._track(path, origin=origin, status="RECOVERED")

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

    def is_safe_to_delete(self, path: str) -> str:
        """Check if it's safe to delete this path. Pure query — no writes.

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
            return "ALLOW: authorized_verified"

        # Authorized but no verified copy: confirm
        if entry.delete_authorized and not entry.verified_copy:
            return "CONFIRM: authorized but no verified copy"

        # Critical asset: recovered from history (hard to recreate user data),
        # no copy, no backup, not authorized → BLOCK.
        if entry.origin == "recovered_from_history" and not entry.verified_copy and not entry.backup_location:
            return "BLOCK: critical_asset_no_copy_no_backup"

        # Agent-generated asset (agent can recreate): CONFIRM, not BLOCK.
        # Aligns with the asset-aware decision table: only recovered/user-created
        # critical assets hard-block; agent-generated work needs confirmation.
        if entry.origin == "agent_generated" and not entry.verified_copy and not entry.backup_location:
            return "CONFIRM: agent_generated_unverified"

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
        if resolved in self._entries:
            return self._entries[resolved]
        entry = AssetEntry(path=resolved)
        self._entries[resolved] = entry
        return entry


class AssetTracker:
    """Auto-tracking layer that hook adapters call on agent events.

    Instead of manually calling ledger.track() / ledger.move(),
    adapters call these event handlers and the tracker updates
    the ledger automatically.

    Usage in adapter:
        tracker = AssetTracker(ledger)

        # On PostToolUse Write:
        tracker.on_write(filepath, origin_hint="recovered")

        # On PostToolUse Bash mv:
        tracker.on_move(source, dest)

        # On PostToolUse Bash rm:
        tracker.on_delete(filepath)
    """

    def __init__(self, ledger: AssetLedger):
        self.ledger = ledger

    def on_write(self, path: str, origin_hint: str = "unknown") -> AssetEntry:
        """Auto-track when agent writes a file."""
        return self.ledger.track(path, origin=origin_hint)

    def on_move(self, source: str, dest: str) -> AssetEntry:
        """Auto-track when agent moves a file."""
        # If source was tracked, the destination inherits its origin
        src_entry = self.ledger.get(source)
        if src_entry:
            # Mutate in place then save ONCE (track() would save, then the
            # field updates would trigger a second _save()).
            entry = self.ledger._get_or_create(str(Path(dest).resolve()))
            entry.origin = src_entry.origin
            entry.moved_from = str(Path(source).resolve())
            entry.status = "MOVED"
            entry.verified_copy = False
            entry.updated_at = time.time()
            self.ledger._save()
            return entry
        else:
            return self.ledger.move(dest, from_dir=str(Path(source).parent), to_dir=str(Path(dest).parent))

    def on_delete(self, path: str) -> None:
        """Clean up tracking when agent deletes a file."""
        entry = self.ledger.get(path)
        if entry and entry.verified_copy and entry.delete_authorized:
            self.ledger.untrack(path)

    def on_read(self, path: str) -> None:
        """Mark path as potentially interesting (doesn't track yet)."""
        pass  # Read events don't create entries, but could trigger heuristic tracking
