from app.rag import default_knowledge_base


def test_faiss_retrieval_returns_relevant_finops_policy() -> None:
    references = default_knowledge_base().retrieve(
        "COST-EIP-001 未使用 Elastic IP 每月 IPv4 費用",
        top_k=2,
    )

    assert references
    assert references[0].source == "finops-policy.md"
    assert references[0].title == "未使用的公有 IPv4"
    assert references[0].score > 0
