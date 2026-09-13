"""Unit tests for guard.py context-aware decisions: recursive-rm fragment
bypass regression + asset-ledger mv source/dest checks. Run with pytest.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acs_core"))

from asset_ledger import AssetLedger
from guard import check_bash_with_context


def _ledger(tmp):
    return AssetLedger(str(Path(tmp) / "assets.json"))


# ── Recursive-rm fragment bypass (v1.7.1 CRITICAL regression) ───────────────

def test_fragment_rm_forms_all_block():
    """'rm -r'f' /' etc. are exactly 'rm -rf /' to bash and must BLOCK in the
    context-aware path (was ALLOW before the _shell_normalize fix)."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    for cmd in [
        "rm -rf /",
        "rm -r'f' /",
        'rm -r"f" /',
        "rm -r$(echo f) /",
        r"rm -r\f /",
        "rm -r'f' /etc",
        "rm -r$(echo f) ~",
    ]:
        result = check_bash_with_context(cmd, asset_ledger=ledger)
        assert result["decision"] == "BLOCK", f"{cmd!r} -> {result}"


def test_quoted_payload_not_misjudged():
    """Quoted content is opaque: echo of a dangerous string stays ALLOW."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    result = check_bash_with_context("echo 'rm -rf /'", asset_ledger=ledger)
    assert result["decision"] == "ALLOW"


def test_rebuildable_rm_still_allowed():
    """Non-catastrophic recursive rm on rebuildable/temp targets keeps its
    asset-aware ALLOW (the blanket block is correctly skipped)."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    result = check_bash_with_context("rm -rf /tmp/build", asset_ledger=ledger)
    assert result["decision"] == "ALLOW"


# ── mv checks both source and destination ───────────────────────────────────

def test_mv_of_tracked_critical_source_confirms():
    """Regression: mv only checked the DEST, so a BLOCK-level asset could be
    silently relocated to an untracked path (deleting it there only CONFIRM).
    Moving a tracked critical SOURCE must CONFIRM."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    ledger.track("/tmp/critical_data", origin="recovered_from_history")
    result = check_bash_with_context(
        "mv /tmp/critical_data /tmp/moved_data", asset_ledger=ledger
    )
    assert result["decision"] == "CONFIRM", result
    assert "mv_tracked_asset" in result["reason"]


def test_mv_of_verified_source_allows():
    """A tracked + authorized + verified asset may be relocated freely."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    ledger.track("/tmp/ok_asset", origin="agent_generated")
    ledger.mark_verified("/tmp/ok_asset")
    ledger.authorize_delete("/tmp/ok_asset")
    result = check_bash_with_context(
        "mv /tmp/ok_asset /tmp/elsewhere", asset_ledger=ledger
    )
    assert result["decision"] == "ALLOW", result


def test_mv_untracked_both_sides_allows():
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    result = check_bash_with_context(
        "mv /tmp/plain_a /tmp/plain_b", asset_ledger=ledger
    )
    assert result["decision"] == "ALLOW"


def test_mv_over_tracked_dest_still_checked():
    """Overwriting a tracked dest (e.g. a BLOCK-level asset) also CONFIRMs."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    ledger.track("/tmp/protected_target", origin="recovered_from_history")
    result = check_bash_with_context(
        "mv /tmp/source_file /tmp/protected_target", asset_ledger=ledger
    )
    assert result["decision"] == "CONFIRM", result


def test_rm_of_tracked_critical_still_blocks():
    """rm of a BLOCK-level tracked asset must still BLOCK (unchanged)."""
    tmp = tempfile.mkdtemp()
    ledger = _ledger(tmp)
    ledger.track("/tmp/critical_data", origin="recovered_from_history")
    result = check_bash_with_context("rm -rf /tmp/critical_data", asset_ledger=ledger)
    assert result["decision"] == "BLOCK", result
