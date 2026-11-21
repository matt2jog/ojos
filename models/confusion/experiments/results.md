# DevEmo+ accuracy experiments

The frozen motion classifier had the highest development accuracy at 70.4%, compared with 66.7% for the baseline GRU. Its gain of 3.8 percentage points fell short of the five-point minimum in the protocol committed before the run (`23d3b71`). It won two of four folds, and the paired 95% participant-bootstrap interval for the gain was −4.0 to +11.3 percentage points. Neither candidate advanced, and the original test split stayed sealed for this experiment. [Fixed protocol](protocol.md)

The four participant-disjoint folds scored 186 of 194 development clips from 41 of 42 participants. All variants scored the same 65 confusion clips and 121 neutral clips at a fixed 0.5 threshold.

| Model | Correct | Accuracy | Balanced accuracy | Average precision |
| --- | ---: | ---: | ---: | ---: |
| Always neutral | 121/186 | 65.1% | 50.0% | 0.349 |
| Pooled CNN | 108/186 | 58.1% | 54.2% | 0.465 |
| Baseline GRU | 124/186 | 66.7% | 61.6% | 0.531 |
| Regularized GRU | 116/186 | 62.4% | 57.5% | 0.416 |
| Frozen motion classifier | 131/186 | 70.4% | 65.5% | 0.558 |

| Fold | Participants scored | Clips scored | Baseline GRU accuracy | Frozen motion accuracy |
| --- | ---: | ---: | ---: | ---: |
| 1 | 11 | 46 | 65.2% | 63.0% |
| 2 | 10 | 47 | 63.8% | 72.3% |
| 3 | 10 | 45 | 73.3% | 66.7% |
| 4 | 10 | 48 | 64.6% | 79.2% |

The bootstrap resamples participant-level predictions from this fixed fold assignment. Uncertainty across alternative fold assignments and on newly recruited participants remains unmeasured. The result applies to annotated DevEmo+ clips. A further accuracy claim needs an independent participant cohort, and live interval performance needs continuous sessions with timestamped labels.

The matrix ran on the A100 in `/workspace/ojos-confusion-accuracy` under supervisor, using the shared GPU lock. The original 8 Hz prepared manifest fingerprint, per-fold metrics, bootstrap intervals and decision are in [development.json](development.json). The VPS run evidence is under `/workspace/ojos-runs/confusion/accuracy`.
