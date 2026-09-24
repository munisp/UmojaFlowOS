# Trained-weight provenance

Binary `.pt` weights are sha256-pinned to the metadata below and ship as a
release artifact bundle (`umojaflowos-trained-models-and-registry.zip`).
They regenerate deterministically with `python scripts/train_all.py --workspace runtime --seed 42`.

| Model | Version | Stage | sha256 (weights) | Key metrics |
|---|---|---|---|---|
| credit_net | v20260924002519 | production | `b195fd1c4e88c706…` | roc_auc=0.7828, pr_auc=0.5412 |
| credit_net | v20260924002724 | staging | `45ec9fbe3301ecf8…` | roc_auc=0.7663, pr_auc=0.5792 |
| credit_net | v20260924003004 | staging | `51fd42518887bc70…` | roc_auc=0.7828, pr_auc=0.5412 |
| credit_net | v20260924003212 | staging | `9e573a1c4fb1ab6c…` | roc_auc=0.7828, pr_auc=0.5412 |
| fraud_autoencoder | v20260924002519 | production | `6003d4f5df755616…` | roc_auc=0.9720, pr_auc=0.9051 |
| fraud_autoencoder | v20260924002724 | staging | `5839494a93f4ab78…` | roc_auc=0.8699, pr_auc=0.7386 |
| fraud_autoencoder | v20260924003004 | staging | `9dea6ce28ea0cbc5…` | roc_auc=0.9720, pr_auc=0.9051 |
| fraud_autoencoder | v20260924003212 | staging | `7e456affe339caf1…` | roc_auc=0.9720, pr_auc=0.9051 |
| fraud_net | v20260924002519 | staging | `afab60700942232d…` | roc_auc=0.9995, pr_auc=0.9806 |
| fraud_net | v20260924002724 | staging | `6d0c38c7fb76b143…` | roc_auc=0.9962, pr_auc=0.9464 |
| fraud_net | v20260924003004 | staging | `215ccd4227de9aa4…` | roc_auc=0.9995, pr_auc=0.9806 |
| fraud_net | v20260924003212 | production | `fefe9ecde5afe736…` | roc_auc=0.9995, pr_auc=0.9806 |
| mule_graphsage | v20260924002519 | production | `fe038d453c869e4e…` | roc_auc=1.0000, pr_auc=1.0000 |
| mule_graphsage | v20260924002724 | staging | `e48e37a81fc71375…` | roc_auc=1.0000, pr_auc=1.0000 |
| mule_graphsage | v20260924003004 | staging | `c724317753910bd9…` | roc_auc=1.0000, pr_auc=1.0000 |
| mule_graphsage | v20260924003212 | staging | `9cc2b86e088e4c59…` | roc_auc=1.0000, pr_auc=1.0000 |
