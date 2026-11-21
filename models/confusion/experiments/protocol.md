# Confusion accuracy experiment protocol

Use the existing 8 Hz DevEmo+ research cache. The original train and validation groups form the development cohort. The original test split stays out of feature extraction, training, and scoring during development. The original test results are already known, so a final pass on that split would still need confirmation on a new cohort.

Build four participant-disjoint development folds, approximately balanced by eligible confusion and neutral clip counts. Fix the folds and seeds before training. Evaluate a clip only in its assigned validation fold. Use the baseline's existing abstention rule for clips without usable crops. Report how many clips and participants can be scored.

| Variant | Fixed settings |
| --- | --- |
| Majority control | Always predict neutral. |
| Pooled CNN control | Existing ImageNet-initialized pooled CNN, full fine-tuning, seven epochs. |
| GRU control | Existing ImageNet-initialized GRU, full fine-tuning, eight epochs. |
| Regularized GRU | Train the last four backbone blocks and GRU head for eight epochs. Freeze batch normalization statistics, add 25% projection dropout, and use shared per-clip horizontal flip, contrast and brightness augmentation. |
| Frozen motion classifier | Freeze the ImageNet backbone. Pool within-track temporal variation and adjacent-frame feature changes into a clip vector. Standardize on the training fold and fit one L2-regularized logistic regressor with a fixed penalty of 0.20. |

Use final epochs, seed `20261121` plus the fold index, and a fixed 0.5 clip threshold. The neural variants use the baseline optimizer, batch size, and four-second chunking. The primary measure is pooled out-of-fold accuracy. Report balanced accuracy, average precision, and confusion counts as secondary measures.

A candidate can advance only if it beats the strongest control by at least five percentage points in accuracy and two points in balanced accuracy, wins on accuracy in at least three of four folds, and has a positive lower bound in a paired 95% bootstrap interval that resamples participants. Choose the strongest control by pooled accuracy, with balanced accuracy breaking ties. If both candidates pass, select the one with higher pooled accuracy, using balanced accuracy to break ties.

Stop after this matrix. If neither candidate advances, leave the original test split untouched. If one advances, fit the selected candidate and its comparator once on all development participants and score them together on the reserved test split. Make no follow-up adjustments using the test results. The independent next evaluation requires a fresh participant cohort. The present experiment measures clip classification. It does not estimate deployment accuracy or interval false alarms.
