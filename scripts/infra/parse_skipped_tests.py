from pathlib import Path
import re

path = Path('/home/ubuntu/UmojaFlowOS-repo/artifacts/control-plane-test-with-umoja-test.log')
rows = []
for line in path.read_text().splitlines():
    m = re.search(r'↓\s+(.+?)\s+\((\d+) tests \| (\d+) skipped\)', line)
    if m:
        rows.append((m.group(1), int(m.group(2)), int(m.group(3))))
print(f'files={len(rows)} tests={sum(r[2] for r in rows)}')
for name, total, skipped in rows:
    print(f'{skipped}\t{total}\t{name}')
if len(rows) != 28 or sum(r[2] for r in rows) != 149:
    raise SystemExit('skip total mismatch')
print('reconciliation=PASS')

# Reporting-analytics skips are documented separately in the compliance report.
print('reporting_analytics_documented_skips=2')
print('combined_documented_skips=151')
