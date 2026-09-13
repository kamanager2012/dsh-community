# Retrieval evaluation

This directory contains regression fixtures for the static AI catalogs. They test
whether a natural-language question retrieves the right original section and source;
they are not execution logs, model benchmarks, or claims that a dsh task succeeded.

The current fixture has 44 questions: 32 Chinese and 12 English. Each case records
acceptable record IDs, acceptable source paths, and terms that should appear in the
retrieved context.

Run the baseline evaluator:

```bash
python3 scripts/evaluate_retrieval.py
```

The evaluator reports exact-record Recall@1/3/5 and MRR, source-level Recall@1/3/5 and
MRR, top-result source accuracy, and required-term coverage. Source-level metrics matter
because one answer may be split into several adjacent Markdown sections. It uses the same
deterministic keyword scorer as the local query command;
the first goal is to establish a reproducible baseline before introducing BM25,
embeddings, or reranking.

The report separates an exact-section miss from a source miss. A query can rank a
neighboring section first while still returning the correct Markdown source within the
top five; that is reported as a top-1 ordering miss, not as a missing document.

The publishing workflow currently requires the baseline to keep at least 0.80 Recall@5,
0.65 MRR, 0.70 top-result source accuracy, and 0.90 required-term coverage. These are
regression floors for this fixture, not claims about model quality or runtime behavior.
