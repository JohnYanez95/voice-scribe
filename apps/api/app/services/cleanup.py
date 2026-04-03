import re


def clean_transcript(raw: str) -> str:
    """Rule-based transcript cleanup.

    Applies whitespace normalization, punctuation spacing, repeated-word
    removal, and sentence capitalization. Pure function — no logging,
    no side effects, no config.
    """
    if not raw or not raw.strip():
        return ""

    text = raw

    # 1. Collapse all whitespace runs into a single space
    text = re.sub(r"\s+", " ", text).strip()

    # 2. Remove space before punctuation
    text = re.sub(r"\s+([.,!?:;])", r"\1", text)

    # 3. Ensure space after punctuation (unless end of string or another punctuation)
    text = re.sub(r"([.,!?:;])([^\s.,!?:;])", r"\1 \2", text)

    # 4. Remove consecutive duplicate words (case-insensitive, keep first)
    text = re.sub(r"\b(\w+)(\s+\1)+\b", r"\1", text, flags=re.IGNORECASE)

    # 5. Capitalize first character
    if text:
        text = text[0].upper() + text[1:]

    # 6. Capitalize after sentence-ending punctuation
    text = re.sub(
        r"([.!?]\s+)(\w)", lambda m: m.group(1) + m.group(2).upper(), text
    )

    return text
