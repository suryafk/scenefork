import pytest

from app.devcache import DevCache, request_key
from app.spend import SAM_PER_IMAGE, SpendCapExceeded, SpendLedger, spark_cost


def test_ledger_charges_persist_across_restarts(tmp_path):
    ledger = SpendLedger(tmp_path, cap_usd=1.0)
    ledger.charge("sam-3.1", SAM_PER_IMAGE)
    ledger.charge("muse-spark-1.3", spark_cost(1252, 266))
    again = SpendLedger(tmp_path, cap_usd=1.0)
    assert again.total_usd == pytest.approx(SAM_PER_IMAGE + spark_cost(1252, 266), abs=1e-6)


def test_ledger_refuses_a_call_that_would_pass_the_cap(tmp_path):
    ledger = SpendLedger(tmp_path, cap_usd=0.01)
    ledger.charge("muse-image-1.0", 0.008)
    ledger.check(0.002)  # exactly at the cap is fine
    with pytest.raises(SpendCapExceeded):
        ledger.check(0.0025)


def test_spark_cost_matches_the_price_table():
    # Phase 0 grounding at reasoning_effort=minimal: about 1252 in, 266 out.
    assert spark_cost(1_000_000, 0) == pytest.approx(1.25)
    assert spark_cost(0, 1_000_000) == pytest.approx(4.25)
    assert spark_cost(1252, 266) < 0.003


def test_dev_cache_replays_and_can_be_switched_off(tmp_path):
    key = request_key("sam-3.1", "<0f>1<|point|>", b"jpegbytes")
    assert key != request_key("sam-3.1", "<0f>1<|point|>", b"jpegbytez")
    cache = DevCache(tmp_path / "c", enabled=True)
    assert cache.get(key) is None
    cache.put_json(key, [{"type": "x"}])
    assert cache.get_json(key) == [{"type": "x"}]
    assert cache.hits == 1
    off = DevCache(tmp_path / "c", enabled=False)
    assert off.get(key) is None
