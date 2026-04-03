import pytest

from app.services.cleanup import clean_transcript


class TestEmptyInput:
    def test_empty_string(self):
        assert clean_transcript("") == ""

    def test_whitespace_only(self):
        assert clean_transcript("   \n\t  ") == ""

    def test_none_like_empty(self):
        assert clean_transcript("  ") == ""


class TestWhitespaceNormalization:
    def test_collapses_internal_whitespace(self):
        assert clean_transcript("hello   world") == "Hello world"

    def test_strips_leading_trailing(self):
        assert clean_transcript("  hello world  ") == "Hello world"

    def test_normalizes_tabs_and_newlines(self):
        assert clean_transcript("hello\t\nworld") == "Hello world"


class TestRepeatedWordRemoval:
    def test_removes_consecutive_duplicate(self):
        assert clean_transcript("the the dog") == "The dog"

    def test_case_insensitive_match(self):
        assert clean_transcript("The the dog") == "The dog"

    def test_multiple_duplicates(self):
        assert clean_transcript("I I think think so") == "I think so"

    def test_does_not_remove_non_adjacent(self):
        assert clean_transcript("the dog and the cat") == "The dog and the cat"

    def test_does_not_collapse_substrings(self):
        assert clean_transcript("the there") == "The there"


class TestPunctuation:
    def test_removes_space_before_period(self):
        assert clean_transcript("hello . world") == "Hello. World"

    def test_removes_space_before_comma(self):
        assert clean_transcript("hello , world") == "Hello, world"

    def test_adds_space_after_period(self):
        assert clean_transcript("hello.world") == "Hello. World"

    def test_preserves_trailing_period(self):
        assert clean_transcript("hello world.") == "Hello world."


class TestCapitalization:
    def test_capitalizes_first_character(self):
        assert clean_transcript("hello") == "Hello"

    def test_capitalizes_after_period(self):
        assert clean_transcript("hello. world") == "Hello. World"

    def test_capitalizes_after_exclamation(self):
        assert clean_transcript("wow! great") == "Wow! Great"

    def test_capitalizes_after_question(self):
        assert clean_transcript("what? really") == "What? Really"

    def test_already_capitalized_unchanged(self):
        assert clean_transcript("Hello world") == "Hello world"


class TestCombined:
    def test_multiple_rules(self):
        result = clean_transcript("  the the  hello .  world  ")
        assert result == "The hello. World"

    def test_already_clean(self):
        assert clean_transcript("Hello world.") == "Hello world."

    def test_single_word(self):
        assert clean_transcript("hello") == "Hello"


class TestIdempotency:
    @pytest.mark.parametrize(
        "text",
        [
            "hello world",
            "the the dog",
            "  hello .  world  ",
            "What? Really! Yes.",
            "I I think think so",
            "hello,world.foo",
            "A single word",
            "",
            "   ",
            "Already clean sentence.",
        ],
    )
    def test_idempotent(self, text):
        once = clean_transcript(text)
        twice = clean_transcript(once)
        assert once == twice, f"Not idempotent: {text!r} -> {once!r} -> {twice!r}"


class TestNoLogging:
    def test_module_does_not_import_structlog(self):
        import app.services.cleanup as mod

        source = open(mod.__file__).read()
        assert "structlog" not in source, "cleanup module must not import structlog"
