"""Conversation-aware RAG chat handler.

Orchestrates a single chat turn: resolves follow-up context from history,
retrieves relevant documents, and generates a response that accounts for
the full conversation. Reuses the retrieval pipeline from query.py.

This module is used by the /api/chat endpoint in web.py. The existing
/api/query endpoint (used by SE Copilot) is completely unaffected.
"""

import logging
import time

import anthropic
from openai import OpenAI

from config import (
    AGENT_NAME,
    ANTHROPIC_API_KEY,
    CLAUDE_MODEL,
    OPENAI_CHAT_MODEL,
    agent,
)
from conversation_store import (
    add_message,
    auto_title,
    create_conversation,
    get_recent_messages,
)
from query import (
    SYSTEM_PROMPT,
    build_context,
    embed_query,
    multi_retrieve,
    rewrite_query,
)

logger = logging.getLogger(__name__)

_CONTEXT_WINDOW = 10  # messages (5 user/assistant turns)

_RESOLVE_PROMPT = """\
Given the conversation history below, rewrite the user's latest message \
into a single standalone question that can be understood without the \
conversation. If the message is already standalone, return it unchanged. \
Return ONLY the rewritten question, nothing else.

History:
{history}

Latest message: {message}

Standalone question:"""


def _format_history_for_resolve(messages: list[dict]) -> str:
    """Format recent messages into a readable block for context resolution."""
    lines = []
    for m in messages:
        prefix = "User" if m["role"] == "user" else "Assistant"
        content = m["content"]
        if len(content) > 300:
            content = content[:300] + "..."
        lines.append(f"{prefix}: {content}")
    return "\n".join(lines)


def _resolve_followup(
    openai_client: OpenAI,
    user_message: str,
    recent_messages: list[dict],
) -> str:
    """Rewrite a follow-up message into a standalone query using conversation history."""
    if not recent_messages:
        return user_message

    history_text = _format_history_for_resolve(recent_messages)
    try:
        response = openai_client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            max_tokens=256,
            temperature=0.0,
            messages=[{
                "role": "user",
                "content": _RESOLVE_PROMPT.format(
                    history=history_text,
                    message=user_message,
                ),
            }],
        )
        resolved = response.choices[0].message.content.strip()
        if resolved:
            logger.info("Resolved follow-up: %r -> %r", user_message, resolved)
            return resolved
    except Exception:
        logger.exception("Context resolution failed, using original message")

    return user_message


def _build_llm_messages(
    recent_messages: list[dict],
    context: str,
    user_message: str,
) -> list[dict]:
    """Build the LLM message array with conversation history and retrieved context."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    for m in recent_messages:
        messages.append({"role": m["role"], "content": m["content"]})

    user_content = f"CONTEXT:\n{context}\n\nQUESTION: {user_message}\n\nANSWER:"
    messages.append({"role": "user", "content": user_content})

    return messages


def _call_llm(
    messages: list[dict],
    llm: str,
    openai_client: OpenAI,
    anthropic_client: anthropic.Anthropic,
) -> str:
    """Call the selected LLM with the full message history."""
    if llm == "openai":
        response = openai_client.chat.completions.create(
            model=OPENAI_CHAT_MODEL,
            max_tokens=1024,
            messages=messages,
        )
        return response.choices[0].message.content

    system_msg = messages[0]["content"]
    chat_messages = messages[1:]

    for attempt in range(4):
        try:
            response = anthropic_client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=1024,
                system=system_msg,
                messages=chat_messages,
            )
            return response.content[0].text
        except anthropic.APIStatusError as e:
            if e.status_code in (429, 500, 529) and attempt < 3:
                wait = 2 ** attempt
                logger.warning("API busy, retrying in %ds ...", wait)
                time.sleep(wait)
            else:
                raise


def chat_turn(
    user_message: str,
    collection,
    openai_client: OpenAI,
    anthropic_client: anthropic.Anthropic,
    conversation_id: str | None = None,
    llm: str = "claude",
    category: str | None = None,
    ticker: str | None = None,
) -> dict:
    """Execute one chat turn: resolve context, retrieve, respond, persist.

    Returns:
        {conversation_id, response, sources, elapsed}
    """
    start = time.time()

    if conversation_id is None:
        conversation_id = create_conversation(AGENT_NAME)

    recent = get_recent_messages(conversation_id, limit=_CONTEXT_WINDOW)

    resolved_query = _resolve_followup(openai_client, user_message, recent)

    ticker_filter = ticker.upper() if ticker else None
    all_queries = [resolved_query]
    rewrites = rewrite_query(openai_client, resolved_query)
    if rewrites:
        all_queries.extend(rewrites)

    all_embeddings = [embed_query(openai_client, q) for q in all_queries]
    results = multi_retrieve(
        collection, all_embeddings,
        category=category or None,
        ticker=ticker_filter,
    )

    if not results["documents"][0]:
        answer = "No relevant documents found for this question."
        sources: list[str] = []
    else:
        context = build_context(results)
        llm_messages = _build_llm_messages(recent, context, user_message)
        answer = _call_llm(llm_messages, llm, openai_client, anthropic_client)

        seen: set[str] = set()
        sources = []
        for meta in results["metadatas"][0]:
            src = meta.get("source", "unknown")
            if src not in seen:
                seen.add(src)
                sources.append(src)

    elapsed = round(time.time() - start, 1)

    add_message(conversation_id, "user", user_message)
    add_message(conversation_id, "assistant", answer, sources=sources, elapsed=elapsed)
    auto_title(conversation_id)

    return {
        "conversation_id": conversation_id,
        "response": answer,
        "sources": sources,
        "elapsed": elapsed,
    }
