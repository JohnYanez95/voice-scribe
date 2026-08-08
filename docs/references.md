# References

Voice Scribe implements published work. This page names the papers behind the
model and the commit policy, and the software it builds on, with citations.

License obligations for *redistributed* artifacts are separate and live in
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). This page is
attribution for ideas and tools, including ones that carry no legal requirement.

---

## The speech model

**Whisper** — the ASR model family Voice Scribe runs. Weights are downloaded at
runtime from HuggingFace; this repository does not redistribute them. The
`large-v3` default and the `small`/`medium` fallbacks are all Whisper
checkpoints, converted for CTranslate2 inference.

```bibtex
@InProceedings{pmlr-v202-radford23a,
  title     = {Robust Speech Recognition via Large-Scale Weak Supervision},
  author    = {Radford, Alec and Kim, Jong Wook and Xu, Tao and Brockman, Greg
               and Mcleavey, Christine and Sutskever, Ilya},
  booktitle = {Proceedings of the 40th International Conference on Machine Learning},
  pages     = {28492--28518},
  year      = {2023},
  volume    = {202},
  series    = {Proceedings of Machine Learning Research},
  publisher = {PMLR},
  url       = {https://proceedings.mlr.press/v202/radford23a.html}
}
```

Preprint: [arXiv:2212.04356](https://arxiv.org/abs/2212.04356). Whisper's code
and weights are released by OpenAI under the MIT license.

## The commit policy

Whisper is not a streaming model — it decodes a fixed 30-second window and is
free to revise its whole output on the next pass. Turning it into a live
transcriber requires a policy that decides *which words are safe to show as
final*. Voice Scribe uses **LocalAgreement-2** (protocol clause C7.3): commit
the longest common prefix of the two most recent hypotheses.

That policy is not ours. It comes from Liu, Spanakis & Niehues, who introduced
local agreement as one of three latency-reduction strategies for chunk-based
incremental inference, and found it gave the best quality–latency trade-off:

```bibtex
@inproceedings{liu20s_interspeech,
  title     = {{Low-Latency Sequence-to-Sequence Speech Recognition and
               Translation by Partial Hypothesis Selection}},
  author    = {Danni Liu and Gerasimos Spanakis and Jan Niehues},
  year      = {2020},
  booktitle = {{Interspeech 2020}},
  pages     = {3620--3624},
  doi       = {10.21437/Interspeech.2020-2897},
  issn      = {2958-1796}
}
```

Applying it specifically to Whisper — the combination Voice Scribe's streaming
path is built on — was demonstrated by Macháček, Dabre & Bojar in
Whisper-Streaming, which pairs a local agreement policy with self-adaptive
latency:

```bibtex
@inproceedings{machacek-etal-2023-turning,
  title     = {Turning Whisper into Real-Time Transcription System},
  author    = {Mach{\'a}{\v{c}}ek, Dominik and Dabre, Raj and Bojar, Ond{\v{r}}ej},
  booktitle = {Proceedings of the 13th International Joint Conference on Natural
               Language Processing and the 3rd Conference of the Asia-Pacific
               Chapter of the Association for Computational Linguistics:
               System Demonstrations},
  year      = {2023},
  url       = {https://arxiv.org/abs/2307.14743}
}
```

**What is original here, stated plainly:** the policy is theirs; this repository
is an independent implementation with its own additions — absolute-sample-coordinate
alignment across window slides, timestamp-based left-context suppression, the
withhold-only veto structure (probability floor, edge guard), frontier-anchored
holdback, the two frontier-residue guards (C7.12/C7.13), and the decoder-edge
token merge (C7.14). Those are documented as numbered clauses in
[`v4/protocol.md`](v4/protocol.md), each with the field evidence that produced
it. None of them changes the fact that the core idea is Liu et al.'s.

## Voice activity detection

**Silero VAD** — the client-side speech gate (ONNX, run in the browser via
WASM). Both the v5 and legacy models ship in this repository.

```bibtex
@misc{Silero VAD,
  author       = {Silero Team},
  title        = {Silero VAD: pre-trained enterprise-grade Voice Activity
                  Detector (VAD), Number Detector and Language Classifier},
  year         = {2021},
  publisher    = {GitHub},
  howpublished = {\url{https://github.com/snakers4/silero-vad}}
}
```

The browser integration is [`@ricky0123/vad-web`](https://github.com/ricky0123/vad)
by Ricky Boyce, which supplies the AudioWorklet pipeline and the frame-level
`onFrameProcessed` tap the streaming capture path depends on.

## Inference runtime

- **[faster-whisper](https://github.com/SYSTRAN/faster-whisper)** (SYSTRAN) — the
  Whisper implementation actually executed, including the word-timestamp
  alignment (DTW over cross-attention) that the entire commit policy depends on:
  without per-word times there is no frontier, no edge guard, and no left-context
  suppression.
- **[CTranslate2](https://github.com/OpenNMT/CTranslate2)** (OpenNMT) — the
  inference engine underneath faster-whisper, providing the quantized fp16/int8
  execution that makes real-time decode feasible on a single consumer GPU.

## Citing Voice Scribe

A [`CITATION.cff`](../CITATION.cff) file is at the repository root; GitHub renders
a "Cite this repository" control from it. If you use this work, please also cite
the papers above — particularly Liu et al. and Radford et al., without which
there is nothing here.
