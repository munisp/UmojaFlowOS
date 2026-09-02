#!/usr/bin/env python3
from pathlib import Path
import hashlib, json, re, shutil

root = Path(__file__).resolve().parents[2]
out = root / 'artifacts' / 'external-signoff'
sources = ['artifacts/final_production_readiness_report.md','docs/production_readiness_scorecard.md','docs/production_regulatory_deployment_guide.md','docs/production_readiness_coverage_report.md','docs/compliance_rbac_verification_report.md','artifacts/clean-room-compliance-final.log','artifacts/local-seed/synthetic_nigeria_seed_manifest.json','artifacts/local-seed/seed-verify.log','artifacts/toxiproxy-partition-final.log','artifacts/postgres-privilege-verification-umoja-test.out','artifacts/umoja-app-ddl-denial.out']
def clean(s):
    s = re.sub(r'postgres(?:ql)?://[^\s\'\"`]+','postgresql://[REDACTED]',s,flags=re.I)
    s = re.sub(r'(?i)(password|secret|token|private_key)(\s*[=:]\s*)[^\s,;]+',r'\1\2[REDACTED]',s)
    return re.sub(r'-----BEGIN [^-]+ PRIVATE KEY-----.*?-----END [^-]+ PRIVATE KEY-----','[PRIVATE KEY REDACTED]',s,flags=re.S)
if out.exists(): shutil.rmtree(out)
(out/'evidence').mkdir(parents=True)
items=[]
for rel in sources:
    src=root/rel
    if not src.is_file(): continue
    dst=out/'evidence'/rel; dst.parent.mkdir(parents=True,exist_ok=True)
    dst.write_text(clean(src.read_text(errors='replace')))
    items.append({'path':str(dst.relative_to(out)),'sha256':hashlib.sha256(dst.read_bytes()).hexdigest(),'bytes':dst.stat().st_size})
(out/'README.md').write_text('# UmojaFlowOS External Sign-off Bundle\n\nSanitized engineering evidence only. Synthetic records are not legal or regulatory evidence. Technical evidence is not CBN authorization.\n')
(out/'manifest.json').write_text(json.dumps({'schema_version':'1.0','repository':'munisp/UmojaFlowOS','sanitized':True,'files':items},indent=2)+'\n')
print(f'created {len(items)} sanitized evidence files in {out}')
