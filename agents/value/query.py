"""RAG query interface for the Value agent.

Takes a natural-language question, retrieves relevant chunks from ChromaDB,
and generates an answer using an LLM (OpenAI or Claude).

Usage:
    python query.py "What business outcomes has Datadog driven for retail customers?"
    python query.py "How does Datadog help reduce MTTR?" --category datadoghq.com
    python query.py --interactive
    python query.py "question" --llm openai
"""

import argparse
import json
import sys
import time

import anthropic
import chromadb
from openai import OpenAI

from config import (
    ANTHROPIC_API_KEY,
    CHROMA_COLLECTION,
    CHROMA_PERSIST_DIR,
    CLAUDE_MODEL,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    OPENAI_API_KEY,
    OPENAI_CHAT_MODEL,
)

SYSTEM_PROMPT = """You are a business value and ROI assistant for a Datadog Sales Engineer. \
Your job is to answer questions about business outcomes, customer success stories, competitive \
positioning, and the value proposition of Datadog using ONLY the retrieved context from blog posts.

RULES:
1. Base your answer EXCLUSIVELY on the provided context. Do not use prior knowledge or assumptions.
2. Focus on business impact, ROI, customer outcomes, and competitive advantages.
3. If the context does not contain enough information to fully answer, say exactly what you CAN \
answer and explicitly state what is missing or uncertain. Never guess.
4. Never fabricate customer names, statistics, pricing, or ROI figures.
5. When context chunks conflict or show different versions, note the discrepancy and present both.
6. Cite sources inline using bracket notation, e.g. [Source 1] or [Source 3], so the reader can \
trace every claim back to a specific chunk.
7. Keep answers concise (2-5 sentences) unless the question requires more detail — prefer bullet \
points only for multi-part answers.
8. If the question is ambiguous, briefly state your interpretation before answering.
9. Use a confident, professional tone appropriate for executive and business conversations."""

QUERY_REWRITE_PROMPT = """Generate 2 alternative phrasings of the following question that would \
help retrieve relevant blog posts about business value, customer outcomes, and ROI. \
Include synonyms and related terms. \
Return ONLY a JSON array of strings, no other text.

Question: {question}"""

TOP_K = 5
REWRITE_ENABLED = True


def embed_query(client: OpenAI, question: str) -> list[float]:
    response = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=[question],
        dimensions=EMBEDDING_DIMENSIONS,
    )
    return response.data[0].embedding


def rewrite_query(client: OpenAI, question: str) -> list[str]:
    """Generate alternative query phrasings for better retrieval coverage."""
    try:
        response = client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            max_tokens=256,
            temperature=0.3,
            messages=[
                {"role": "user", "content": QUERY_REWRITE_PROMPT.format(question=question)},
            ],
        )
        raw = response.choices[0].message.content.strip()
        alternatives = json.loads(raw)
        if isinstance(alternatives, list):
            return [q for q in alternatives if isinstance(q, str)]
    except (json.JSONDecodeError, Exception):
        pass
    return []


def retrieve(collection, query_embedding: list[float], top_k: int = TOP_K, category: str | None = None) -> dict:
    where_filter = {"category": category} if category else None
    return collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"],
        where=where_filter,
    )


def multi_retrieve(collection, embeddings: list[list[float]], top_k: int = TOP_K, category: str | None = None) -> dict:
    """Retrieve across multiple query embeddings and deduplicate by content."""
    seen_docs = set()
    merged = {"documents": [[]], "metadatas": [[]], "distances": [[]]}

    for emb in embeddings:
        results = retrieve(collection, emb, top_k=top_k, category=category)
        for doc, meta, dist in zip(
            results["documents"][0],
            results["metadatas"][0],
            results["distances"][0],
        ):
            doc_key = doc[:200]
            if doc_key not in seen_docs:
                seen_docs.add(doc_key)
                merged["documents"][0].append(doc)
                merged["metadatas"][0].append(meta)
                merged["distances"][0].append(dist)

    if merged["documents"][0]:
        combined = sorted(
            zip(merged["documents"][0], merged["metadatas"][0], merged["distances"][0]),
            key=lambda x: x[2],
        )[:top_k]
        merged["documents"][0] = [c[0] for c in combined]
        merged["metadatas"][0] = [c[1] for c in combined]
        merged["distances"][0] = [c[2] for c in combined]

    return merged


def build_context(results: dict) -> str:
    """Format retrieved chunks into a context block for the LLM, including metadata."""
    chunks = []
    for i, (doc, meta, dist) in enumerate(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    )):
        source = meta.get("source", "unknown")
        source_name = source.split("/")[-1] if "/" in source else source
        category = meta.get("category", "")
        header = f"[Source {i + 1}: {source_name}]"
        if category:
            header += f" (category: {category})"
        header += f" [relevance: {1 - dist:.2f}]"
        chunks.append(f"{header}\n{doc}")
    return "\n\n---\n\n".join(chunks)


def ask_claude(client: anthropic.Anthropic, question: str, context: str) -> str:
    user_message = f"""CONTEXT:
{context}

QUESTION: {question}

ANSWER:"""

    for attempt in range(4):
        try:
            response = client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            )
            return response.content[0].text
        except anthropic.APIStatusError as e:
            if e.status_code in (429, 529) and attempt < 3:
                wait = 2 ** attempt
                print(f"  API busy, retrying in {wait}s ...")
                time.sleep(wait)
            else:
                raise


def ask_openai(client: OpenAI, question: str, context: str) -> str:
    user_message = f"""CONTEXT:
{context}

QUESTION: {question}

ANSWER:"""

    response = client.chat.completions.create(
        model=OPENAI_CHAT_MODEL,
        max_tokens=1024,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    )
    return response.choices[0].message.content


def answer_question(question: str, category: str | None = None, llm: str = "claude") -> None:
    start = time.time()

    openai_client = OpenAI(api_key=OPENAI_API_KEY)
    chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)

    try:
        collection = chroma_client.get_collection(name=CHROMA_COLLECTION)
    except Exception:
        print("Error: No knowledge base found. Run 'python ingest.py' first.")
        sys.exit(1)

    if collection.count() == 0:
        print("Error: Knowledge base is empty. Add documents and run 'python ingest.py'.")
        sys.exit(1)

    all_queries = [question]
    if REWRITE_ENABLED:
        rewrites = rewrite_query(openai_client, question)
        if rewrites:
            all_queries.extend(rewrites)

    all_embeddings = [embed_query(openai_client, q) for q in all_queries]
    results = multi_retrieve(collection, all_embeddings, category=category)

    if not results["documents"][0]:
        print("No relevant documents found.")
        return

    context = build_context(results)

    if llm == "openai":
        answer = ask_openai(openai_client, question, context)
    else:
        claude_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        answer = ask_claude(claude_client, question, context)

    elapsed = time.time() - start

    print(f"\n{answer}")
    print(f"\n--- ({elapsed:.1f}s, {llm}, {len(all_queries)} queries) ---")
    print("Sources:")
    seen = set()
    for meta in results["metadatas"][0]:
        source = meta.get("source", "unknown")
        if source not in seen:
            seen.add(source)
            print(f"  - {source}")


def interactive_mode(category: str | None = None, llm: str = "claude") -> None:
    print(f"Value (interactive mode, llm={llm}) — type 'quit' to exit\n")
    while True:
        try:
            question = input("Question: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not question or question.lower() in ("quit", "exit", "q"):
            break
        answer_question(question, category=category, llm=llm)
        print()


def main():
    parser = argparse.ArgumentParser(description="Ask the Value agent a question.")
    parser.add_argument("question", nargs="?", help="Your question")
    parser.add_argument("--category", type=str, default=None, help="Filter by knowledge base category")
    parser.add_argument("--interactive", "-i", action="store_true", help="Interactive mode")
    parser.add_argument("--llm", type=str, default="claude", choices=["claude", "openai"],
                        help="LLM to use for answer generation (default: claude)")
    parser.add_argument("--no-rewrite", action="store_true", help="Disable query rewriting")
    args = parser.parse_args()

    global REWRITE_ENABLED
    if args.no_rewrite:
        REWRITE_ENABLED = False

    if args.interactive:
        interactive_mode(category=args.category, llm=args.llm)
    elif args.question:
        answer_question(args.question, category=args.category, llm=args.llm)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
