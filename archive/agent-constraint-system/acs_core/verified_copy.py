#!/usr/bin/env python3
"""
Verified-Copy-Before-Delete Protocol

Safety protocol that ensures destructive operations on tracked assets
require a verified copy to exist at a separate location before deletion
is allowed.

Integrates with AssetLedger to enforce:
  1. Copy to safe location
  2. Verify copy (SHA-256 checksum match)
  3. Mark verified
  4. Only then: authorize delete → safe to remove

Usage:
    protocol = VerifiedCopyProtocol(ledger)
    protocol.request_delete("/tmp/dramatools")
    # -> "BLOCK: no_verified_copy"
    protocol.verify_copy("/tmp/dramatools", "/backup/dramatools.tar")
    # -> "VERIFIED"
    protocol.request_delete("/tmp/dramatools")
    # -> "ALLOW: verified_copy_exists"
"""
import hashlib
import os
from pathlib import Path
from typing import Optional


class VerifiedCopyProtocol:
    """Enforces verified-copy-before-delete on tracked assets."""

    def __init__(self, ledger):
        self.ledger = ledger

    def request_delete(self, path: str) -> str:
        """Check if a path can be safely deleted. Returns ALLOW/CONFIRM/BLOCK."""
        entry = self.ledger.get(path)
        if entry is None:
            return "ALLOW"

        if not entry.verified_copy and not entry.backup_location:
            return "BLOCK: no_verified_copy"

        if entry.backup_location and not entry.verified_copy:
            return "CONFIRM: backup_exists_not_verified"

        if entry.verified_copy and entry.delete_authorized:
            return "ALLOW: verified_copy_exists"

        return "CONFIRM: requires_authorization"

    def verify_copy(self, source: str, dest: str) -> str:
        """Verify that a copy exists at dest and matches source.

        Returns one of: VERIFIED, MISMATCH, NOT_FOUND, COPIED_AND_VERIFIED
        """
        source_path = Path(source).resolve()
        dest_path = Path(dest).resolve()

        if not source_path.exists():
            return "NOT_FOUND: source"

        if not dest_path.exists():
            return "NOT_FOUND: dest"

        # SHA-256 checksum comparison
        source_hash = self._sha256(source_path)
        dest_hash = self._sha256(dest_path)

        if source_hash == dest_hash:
            self.ledger.mark_verified(str(source_path))
            self.ledger.mark_backup(str(source_path), str(dest_path))
            return "VERIFIED"
        else:
            return "MISMATCH"

    def copy_and_verify(self, source: str, dest: str) -> str:
        """Copy source to dest and verify the copy."""
        import shutil
        source_path = Path(source).resolve()
        dest_path = Path(dest).resolve()

        if not source_path.exists():
            return "NOT_FOUND: source"

        dest_path.parent.mkdir(parents=True, exist_ok=True)

        if source_path.is_dir():
            shutil.copytree(str(source_path), str(dest_path))
        else:
            shutil.copy2(str(source_path), str(dest_path))

        return self.verify_copy(str(source_path), str(dest_path))

    @staticmethod
    def _sha256(path: Path) -> str:
        """Compute SHA-256 hash of a file or directory."""
        hasher = hashlib.sha256()
        if path.is_file():
            with open(path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    hasher.update(chunk)
        elif path.is_dir():
            for root, _, files in sorted(os.walk(path)):
                for fname in sorted(files):
                    fp = Path(root) / fname
                    hasher.update(fp.relative_to(path).as_posix().encode())
                    with open(fp, 'rb') as f:
                        hasher.update(f.read())
        return hasher.hexdigest()
