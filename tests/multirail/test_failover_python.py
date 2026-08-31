import importlib.util
from pathlib import Path
import pytest
_IMPL = Path(__file__).parents[2] / 'services' / 'risk-compliance-core' / 'multirail_failover.py'
_spec = importlib.util.spec_from_file_location('multirail_failover', _IMPL)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
Coordinator, Intent, Submission, Status, UnknownOutcome = (_mod.Coordinator, _mod.Intent, _mod.Submission, _mod.Status, _mod.UnknownOutcome)
class Rail:
    def __init__(self,name,submit=None,query=None,submit_exc=None): self.name=name; self._submit=submit; self._query=query; self.submit_exc=submit_exc; self.calls=0
    def submit(self,i):
        self.calls+=1
        if self.submit_exc: raise self.submit_exc
        return self._submit
    def query(self,i): return self._query

def intent(k='k'): return Intent('i',k)
def test_safe_fallback():
    p=Rail('yellow_card',Submission(Status.FAILED,safe_to_retry=True)); s=Rail('bank',Submission(Status.SUBMITTED,'b1'))
    rail,out=Coordinator().execute(intent(),p,s); assert rail=='bank' and out.reference=='b1'
def test_unknown_blocks_secondary():
    p=Rail('yellow_card',Submission(Status.UNKNOWN)); s=Rail('bank',Submission(Status.SUBMITTED,'b'))
    with pytest.raises(UnknownOutcome): Coordinator().execute(intent(),p,s)
    assert s.calls==0
def test_timeout_with_unknown_query_blocks():
    p=Rail('yellow_card',query=Submission(Status.UNKNOWN),submit_exc=TimeoutError()); s=Rail('bank',Submission(Status.SUBMITTED,'b'))
    with pytest.raises(UnknownOutcome): Coordinator().execute(intent(),p,s)
    assert s.calls==0
def test_idempotency():
    p=Rail('yellow_card',Submission(Status.SUBMITTED,'p1')); s=Rail('bank')
    c=Coordinator(); a=c.execute(intent(),p,s); b=c.execute(intent(),p,s); assert a==b and p.calls==1
