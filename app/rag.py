from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import faiss
import numpy as np

from app.models import KnowledgeReference

WORD_PATTERN = re.compile(r"[a-z0-9][a-z0-9:*/._-]*", re.IGNORECASE)
HAN_PATTERN = re.compile(r"[\u3400-\u9fff]+")
RULE_PATTERN = re.compile(r"\b(?:SEC|COST|GOV)-[A-Z0-9]+-[0-9]+\b", re.IGNORECASE)


@dataclass(frozen=True)
class KnowledgeChunk:
    source: str
    title: str
    content: str


def _tokens(text: str) -> list[str]:
    normalized = text.lower()
    tokens = WORD_PATTERN.findall(normalized)
    for rule_id in RULE_PATTERN.findall(normalized):
        tokens.extend([f"rule:{rule_id.lower()}"] * 6)
    for sequence in HAN_PATTERN.findall(normalized):
        tokens.extend(sequence)
        tokens.extend(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return tokens


def _vectorize(texts: list[str], dimension: int) -> np.ndarray:
    matrix = np.zeros((len(texts), dimension), dtype="float32")
    for row, text in enumerate(texts):
        for token in _tokens(text):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            column = int.from_bytes(digest, "little") % dimension
            matrix[row, column] += 1.0
    faiss.normalize_L2(matrix)
    return matrix


def _load_markdown_chunks(root: Path) -> list[KnowledgeChunk]:
    chunks: list[KnowledgeChunk] = []
    for path in sorted(root.glob("*.md")):
        current_title = path.stem
        current_lines: list[str] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("## "):
                if current_lines:
                    content = "\n".join(current_lines).strip()
                    if content:
                        chunks.append(KnowledgeChunk(path.name, current_title, content))
                current_title = line.removeprefix("## ").strip()
                current_lines = []
            elif not line.startswith("# "):
                current_lines.append(line)
        content = "\n".join(current_lines).strip()
        if content:
            chunks.append(KnowledgeChunk(path.name, current_title, content))
    return chunks


class FaissKnowledgeBase:
    """Small self-hosted FAISS index using deterministic hashed text features."""

    def __init__(self, root: Path, dimension: int = 512) -> None:
        self.chunks = _load_markdown_chunks(root)
        self.dimension = dimension
        self.index = faiss.IndexFlatIP(dimension)
        if self.chunks:
            texts = [f"{chunk.title}\n{chunk.content}" for chunk in self.chunks]
            self.index.add(_vectorize(texts, dimension))

    def retrieve(self, query: str, top_k: int = 3) -> list[KnowledgeReference]:
        if not self.chunks or not _tokens(query):
            return []
        limit = min(top_k, len(self.chunks))
        scores, indices = self.index.search(_vectorize([query], self.dimension), limit)
        references: list[KnowledgeReference] = []
        for score, index in zip(scores[0], indices[0], strict=True):
            if index < 0 or score <= 0:
                continue
            chunk = self.chunks[int(index)]
            references.append(
                KnowledgeReference(
                    source=chunk.source,
                    title=chunk.title,
                    score=round(float(score), 4),
                    excerpt=chunk.content.replace("\n", " ")[:260],
                )
            )
        return references


@lru_cache(maxsize=1)
def default_knowledge_base() -> FaissKnowledgeBase:
    root = Path(__file__).resolve().parents[1] / "knowledge"
    return FaissKnowledgeBase(root)
