import importlib.util
from pathlib import Path

path = Path(__file__).parents[2] / 'services' / 'risk-compliance-core' / 'multirail_failover.py'
spec = importlib.util.spec_from_file_location('impl', path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
Coordinator, Intent, Submission, Status, UnknownOutcome = mod.Coordinator, mod.Intent, mod.Submission, mod.Status, mod.UnknownOutcome

class Rail:
    def __init__(self, name, submit=None, query=None, submit_exc=None): self.name, self.submit_value, self.query_value, self.submit_exc, self.calls = name, submit, query, submit_exc, 0
    def submit(self, _):
        self.calls += 1
        if self.submit_exc: raise self.submit_exc
        return self.submit_value
    def query(self, _): return self.query_value

def check(condition, message):
    if not condition: raise AssertionError(message)

def main():
    check(Coordinator().execute(Intent('i','k'), Rail('yellow_card', Submission(Status.FAILED, safe_to_retry=True)), Rail('bank', Submission(Status.SUBMITTED, 'b')))[0] == 'bank', 'safe fallback failed')
    bank = Rail('bank', Submission(Status.SUBMITTED, 'b'))
    try: Coordinator().execute(Intent('i','k2'), Rail('yellow_card', Submission(Status.UNKNOWN)), bank); raise AssertionError('unknown outcome allowed fallback')
    except UnknownOutcome: pass
    primary = Rail('yellow_card', query=Submission(Status.UNKNOWN), submit_exc=TimeoutError())
    try: Coordinator().execute(Intent('i','k3'), primary, bank); raise AssertionError('timeout unknown allowed fallback')
    except UnknownOutcome: pass
    primary = Rail('yellow_card', Submission(Status.SUBMITTED, 'p'))
    c = Coordinator(); a = c.execute(Intent('i','k4'), primary, bank); b = c.execute(Intent('i','k4'), primary, bank)
    check(a == b and primary.calls == 1, 'idempotency failed')
    print('python multi-rail smoke: PASS (4 cases)')

if __name__ == '__main__': main()
