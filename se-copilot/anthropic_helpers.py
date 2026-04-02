"""Helpers for working with Anthropic API responses."""

from __future__ import annotations


def extract_text(response) -> str:
    """Extract the text content from an Anthropic Messages response.

    Handles responses that include extended thinking blocks by finding the
    first TextBlock rather than assuming content[0] is always text.
    """
    for block in response.content:
        if block.type == "text":
            return block.text
    return ""
